import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const entry = resolve("dist/index.js");
const root = resolve("../..");
const catalogPath = resolve(root, "artifacts/canvas-api/canvas-api-catalog.json");
const readyLine = "[morrow-canvas-connector] ws://";
const readyDeadlineMs = 30_000;
const exitDeadlineMs = 5_000;
/** One parent check plus the shutdown deadline, with room for a busy machine. */
const orphanDeadlineMs = 10_000;

const children: ChildProcess[] = [];
const strays: number[] = [];
const descriptors: number[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const pid of strays.splice(0)) {
    if (running(pid)) process.kill(pid, "SIGKILL");
  }
  for (const descriptor of descriptors.splice(0)) closeSync(descriptor);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "morrow-connector-shutdown-"));
  directories.push(directory);
  return directory;
}

function connectorEnvironment(directory: string, port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MORROW_CANVAS_CATALOG_PATH: catalogPath,
    MORROW_CANVAS_CONNECTOR_STATE: join(directory, "connector.json"),
    MORROW_CANVAS_CONNECTOR_PORT: String(port),
    MORROW_CANVAS_CONNECTOR_TOKEN: "connector-shutdown-secret-".repeat(3),
  };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test port unavailable");
  const { port } = address;
  await new Promise<void>((closed) => server.close(() => closed()));
  return port;
}

async function expectPortFree(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((listening, failed) => {
    const onError = (error: Error): void => failed(new Error(`bridge port ${port} is still held: ${error.message}`));
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      listening();
    });
  });
  await new Promise<void>((closed) => server.close(() => closed()));
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parentPid(pid: number): number {
  return Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)]).toString().trim());
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitForReady(child: ChildProcess): Promise<void> {
  const stderr = child.stderr;
  if (!stderr) throw new Error("connector stderr is not piped");
  let text = "";
  await new Promise<void>((ready, failed) => {
    const stop = (): void => {
      clearTimeout(timer);
      stderr.off("data", onData);
      child.off("exit", onExit);
    };
    const onData = (chunk: Buffer): void => {
      text += chunk.toString();
      if (!text.includes(readyLine)) return;
      stop();
      ready();
    };
    const onExit = (): void => {
      stop();
      failed(new Error(`connector exited before it was ready: ${text.trim() || "(no output)"}`));
    };
    const timer = setTimeout(() => {
      stop();
      failed(new Error(`connector was not ready in ${readyDeadlineMs} ms: ${text.trim() || "(no output)"}`));
    }, readyDeadlineMs);
    stderr.on("data", onData);
    child.once("exit", onExit);
  });
}

/**
 * Starts the connector on a free port. Another process on this machine can take
 * the port between the check and the bind, so a refused bind is retried rather
 * than reported as a shutdown defect.
 */
async function startConnector(directory: string): Promise<{ child: ChildProcess; port: number }> {
  let failure: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = await availablePort();
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: connectorEnvironment(directory, port),
    });
    children.push(child);
    try {
      await waitForReady(child);
      return { child, port };
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (!failure.message.includes("already in use")) throw failure;
    }
  }
  throw failure ?? new Error("connector did not start");
}

async function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((exited, failed) => {
    const timer = setTimeout(
      () => failed(new Error(`connector was still running ${exitDeadlineMs} ms after its input ended`)),
      exitDeadlineMs,
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      exited({ code, signal });
    });
  });
}

async function waitForProcessGone(pid: number, deadlineMs: number): Promise<number> {
  const started = Date.now();
  for (;;) {
    if (!running(pid)) return Date.now() - started;
    if (Date.now() - started > deadlineMs) {
      throw new Error(`connector ${pid} was still running ${deadlineMs} ms after the process that started it left`);
    }
    await delay(50);
  }
}

/**
 * Starts the connector from a short-lived process that leaves once the bridge is
 * up, so the connector is reparented while its input stays open. The input is a
 * FIFO this test holds, which is what keeps the end-of-input path out of the way.
 */
async function startOrphanedConnector(directory: string, port: number): Promise<number> {
  const fifo = join(directory, "stdin.fifo");
  const log = join(directory, "connector.log");
  execFileSync("mkfifo", [fifo]);
  writeFileSync(log, "");
  descriptors.push(openSync(fifo, "r+"));
  const launcher = [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    "const [entry, fifo, log, cwd] = process.argv.slice(1);",
    "const stdio = [fs.openSync(fifo, 'r'), 'ignore', fs.openSync(log, 'a')];",
    "const child = spawn(process.execPath, [entry], { cwd, stdio });",
    "child.unref();",
    "process.stdout.write(`${child.pid}\\n`);",
    `const ready = () => fs.readFileSync(log, 'utf8').includes(${JSON.stringify(readyLine)});`,
    "const wait = setInterval(() => { if (ready()) { clearInterval(wait); process.exit(0); } }, 100);",
  ].join("\n");
  const parent = spawn(process.execPath, ["-e", launcher, entry, fifo, log, root], {
    stdio: ["ignore", "pipe", "pipe"],
    env: connectorEnvironment(directory, port),
  });
  children.push(parent);
  let printed = "";
  parent.stdout?.on("data", (chunk: Buffer) => { printed += chunk.toString(); });
  const exit = await new Promise<number | null>((exited, failed) => {
    const timer = setTimeout(
      () => failed(new Error(`the process that starts the connector did not leave: ${readFileSync(log, "utf8").trim() || "(no connector output)"}`)),
      readyDeadlineMs,
    );
    parent.once("exit", (code) => {
      clearTimeout(timer);
      exited(code);
    });
  });
  const pid = Number(printed.trim());
  if (Number.isInteger(pid) && pid > 1) strays.push(pid);
  expect(exit).toBe(0);
  expect(Number.isInteger(pid) && pid > 1).toBe(true);
  expect(readFileSync(log, "utf8")).toContain(readyLine);
  return pid;
}

describe("canvas connector shutdown", () => {
  it("leaves and frees the bridge port when its assistant closes the input", async () => {
    const { child, port } = await startConnector(temporaryDirectory());
    child.stdin?.end();
    expect(await waitForExit(child)).toEqual({ code: 0, signal: null });
    await expectPortFree(port);
  }, 60_000);

  it.skipIf(process.platform === "win32")(
    "leaves and frees the bridge port when the process that started it is gone",
    async () => {
      const directory = temporaryDirectory();
      const port = await availablePort();
      const pid = await startOrphanedConnector(directory, port);
      // The connector can already have acted on the reparenting by now.
      if (running(pid)) expect(parentPid(pid)).toBe(1);
      await waitForProcessGone(pid, orphanDeadlineMs);
      await expectPortFree(port);
    },
    60_000,
  );
});
