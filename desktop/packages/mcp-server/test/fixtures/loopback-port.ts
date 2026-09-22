import { connect as connectTcp, createServer } from "node:net";

const LOOPBACK_HOST = "127.0.0.1";

/**
 * The range these tests draw Bridge ports from. It sits below the ephemeral
 * range macOS (49152+) and Linux (32768+) hand out on their own, so the
 * operating system never gives one of these ports to an unrelated outgoing
 * socket while a test is starting the process that binds it. Binding port 0
 * instead, as these tests used to, takes a port out of that ephemeral range and
 * hands it back to the pool the moment the check closes.
 */
const FIRST_TEST_PORT = 20_480;
const LAST_TEST_PORT = 32_767;

/**
 * The port a real Morrow uses, from packages/canvas-connector-mcp/src/config.ts.
 * It falls inside the range above, and a test must never take it: the person
 * running these tests can have their own Morrow open on this computer.
 */
const INSTALLED_BRIDGE_PORT = 32_147;

/** How many candidate ports one reservation tries before it gives up. */
const RESERVE_ATTEMPTS = 5;

/** How long assertPortListening waits for the port to accept a connection. */
const LISTEN_TIMEOUT_MS = 5_000;

/** How long one connection attempt inside assertPortListening may take. */
const CONNECT_TIMEOUT_MS = 250;

/** How long assertPortListening waits between attempts. */
const POLL_INTERVAL_MS = 50;

export interface ReserveLoopbackPortOptions {
  /** How many candidate ports to try. Defaults to RESERVE_ATTEMPTS. */
  readonly attempts?: number;
  /**
   * Picks the next candidate port. The default draws at random from the test
   * range; test/loopback-port.test.ts passes its own to force a collision.
   */
  readonly candidate?: () => number;
}

function randomTestPort(): number {
  const port = FIRST_TEST_PORT + Math.floor(Math.random() * (LAST_TEST_PORT - FIRST_TEST_PORT + 1));
  return port === INSTALLED_BRIDGE_PORT ? port + 1 : port;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/** True when this process can bind the port on loopback right now. */
async function portIsFree(port: number): Promise<boolean> {
  const server = createServer();
  const bound = await new Promise<boolean>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false);
      else reject(error);
    });
    server.listen(port, LOOPBACK_HOST, () => resolve(true));
  });
  if (!bound) return false;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return true;
}

/** True when something accepts a loopback connection on the port. */
async function portIsListening(port: number, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connectTcp({ port, host: LOOPBACK_HOST });
    const settle = (listening: boolean): void => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

/**
 * Returns a loopback port nothing holds, proved by binding it and letting it go
 * again. A candidate another program already holds is skipped for a fresh one,
 * up to RESERVE_ATTEMPTS times, so a stale connector or a second agent running
 * the same tests costs one more draw instead of the run.
 *
 * The bind still ends before the process under test starts, so the port is a
 * reservation, not a lock. Pair it with assertPortListening once that process is
 * up: a port another program took in between then fails the test by name inside
 * the deadline instead of leaving a WebSocket connect waiting.
 */
export async function reserveLoopbackPort(options: ReserveLoopbackPortOptions = {}): Promise<number> {
  const attempts = options.attempts ?? RESERVE_ATTEMPTS;
  const candidate = options.candidate ?? randomTestPort;
  const held: number[] = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = candidate();
    if (await portIsFree(port)) return port;
    held.push(port);
  }
  throw new Error(
    `no free loopback port after ${attempts} attempts: ${held.join(", ")} are all in use on ${LOOPBACK_HOST}`,
  );
}

/**
 * Waits until something accepts a connection on the loopback port, and throws a
 * named failure when nothing does.
 *
 * Call it after the process that binds the port has started and before the
 * first WebSocket connect. The connector keeps running without the Bridge port
 * when another Morrow already holds it (packages/canvas-connector-mcp/src/index.ts),
 * so a lost port is otherwise silent: the test connects to nothing and waits.
 *
 * It proves that something accepts connections there, not which program does.
 * A port another program holds still fails the test, one step later, when the
 * bridge client in test/fixtures/bridge-client.ts names the close code.
 */
export async function assertPortListening(port: number, timeoutMs: number = LISTEN_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (await portIsListening(port, Math.max(1, Math.min(CONNECT_TIMEOUT_MS, remaining)))) return;
    if (Date.now() >= deadline) break;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    `nothing is listening on ${LOOPBACK_HOST}:${port} after ${timeoutMs} ms. `
    + "The process that should hold the Bridge port did not take it, or another program has it.",
  );
}
