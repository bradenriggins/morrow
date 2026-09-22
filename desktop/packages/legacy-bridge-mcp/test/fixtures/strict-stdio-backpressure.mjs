import { StrictStdioServerTransport } from "../../dist/strict-stdio.js";

const transport = new StrictStdioServerTransport();
transport.onmessage = (message) => {
  const pending = transport.send({
    jsonrpc: "2.0",
    id: "id" in message ? message.id : null,
    result: { value: "x".repeat(4 * 1024 * 1024) },
  });
  process.stderr.write(process.stdout.writableNeedDrain ? "BACKPRESSURED\n" : "NOT_BACKPRESSURED\n");
  void pending.catch((error) => {
    if (!(error instanceof Error) || !error.message.includes("closed")) {
      process.stderr.write(`UNEXPECTED:${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  });
};
transport.onerror = (error) => {
  process.stderr.write(`UNEXPECTED:${error.message}\n`);
  process.exitCode = 1;
};
await transport.start();
process.stdin.resume();
