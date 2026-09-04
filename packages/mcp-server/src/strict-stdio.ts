import {
  deserializeMessage,
  INVALID_REQUEST,
  PARSE_ERROR,
  type JSONRPCMessage,
  type Transport,
} from "@modelcontextprotocol/server";

const MAX_WIRE_MESSAGE_BYTES = 16 * 1024 * 1024;

export class StrictStdioServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private buffer = "";
  private closed = false;
  private started = false;

  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer += chunk.toString();
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
    this.started = true;
    process.stdin.on("data", this.onData);
    process.stdin.on("error", this.onInputError);
    process.stdin.once("end", this.onInputEnd);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error("StrictStdioServerTransport is closed");
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
        process.stdout.off("error", onError);
        process.stdout.off("drain", onDrain);
      };
      process.stdout.once("error", onError);
      if (process.stdout.write(`${JSON.stringify(message)}\n`)) {
        cleanup();
        resolve();
      } else {
        process.stdout.once("drain", onDrain);
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    process.stdin.off("data", this.onData);
    process.stdin.off("error", this.onInputError);
    process.stdin.off("end", this.onInputEnd);
    this.buffer = "";
    this.onclose?.();
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
