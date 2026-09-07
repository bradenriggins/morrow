import { WebSocket } from "ws";
import {
  BRIDGE_PATH,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SCHEMAS,
  parseBridgeJson,
  serializeBridgeMessage,
  type BridgeBinding,
  type BridgeCommand,
  type BridgeProblem,
  type BridgeReady,
} from "@morrow/bridge-protocol";
import { isJsonObject, type JsonObject } from "@morrow/contracts";

/**
 * The runtime revision the connector expects by default, from
 * packages/canvas-connector-mcp/src/config.ts. A hello carrying any other value
 * is refused with close code 4403.
 */
export const BRIDGE_TEST_RUNTIME_REVISION = "1.0.0-rc.2";

/**
 * The deadline on every wait. The bridge refuses a mismatched hello by closing
 * the socket in packages/bridge-loopback/src/index.ts, and a WebSocket "message"
 * wait never rejects on a close, so a test without a deadline waits for a
 * message that never arrives. Every wait here fails with the close code and
 * reason, or with this deadline, so a refused handshake is a fast, named test
 * failure instead of silence.
 */
export const BRIDGE_TEST_WAIT_MS = 5_000;

export interface BridgeCloseInfo {
  readonly code: number;
  readonly reason: string;
}

export class BridgeClosedError extends Error {
  readonly code: number;
  readonly reason: string;

  constructor(waitingFor: string, close: BridgeCloseInfo) {
    super(`the bridge closed with code ${close.code} ${close.reason || "(no reason)"} while waiting for ${waitingFor}`);
    this.name = "BridgeClosedError";
    this.code = close.code;
    this.reason = close.reason;
  }
}

export class BridgeTimeoutError extends Error {
  constructor(waitingFor: string, timeoutMs: number) {
    super(`the bridge did not deliver ${waitingFor} within ${timeoutMs} ms`);
    this.name = "BridgeTimeoutError";
  }
}

export interface BridgeTestClientOptions {
  readonly port: number;
  readonly token: string;
  readonly extensionId: string;
  readonly catalogDigest: string;
  readonly bindings?: readonly BridgeBinding[];
  /** Defaults to BRIDGE_TEST_RUNTIME_REVISION. Any other value is refused with 4403. */
  readonly runtimeRevision?: string;
  /** Defaults to the extension origin for extensionId. A different id is refused with 4403. */
  readonly origin?: string;
  /** Deadline for the handshake and for every later wait. Defaults to BRIDGE_TEST_WAIT_MS. */
  readonly timeoutMs?: number;
}

interface Stall {
  readonly waitingFor: string;
  readonly reject: (error: Error) => void;
}

interface CommandWaiter {
  readonly predicate: (command: BridgeCommand) => boolean;
  readonly settle: (command: BridgeCommand) => void;
}

/**
 * One extension-side bridge client for tests: it opens the socket, keeps the
 * single "message" listener, and turns a refused or dropped connection into a
 * rejected wait that names the close code.
 */
export class BridgeTestClient {
  private readonly stalls = new Set<Stall>();
  private readonly waiters = new Set<CommandWaiter>();
  private readonly handlers = new Set<(command: BridgeCommand) => void>();
  private readonly commands: BridgeCommand[] = [];
  private readySettle: ((ready: BridgeReady) => void) | null = null;
  private readyMessage: BridgeReady | null = null;
  private closeInfo: BridgeCloseInfo | null = null;
  private socketError: Error | null = null;

  constructor(readonly socket: WebSocket, private readonly timeoutMs: number) {
    socket.on("message", (raw) => this.receive(raw.toString()));
    socket.on("error", (error: Error) => {
      this.socketError = new Error(`the bridge socket failed: ${error.message}`);
      this.settleTerminal();
    });
    socket.on("close", (code: number, reason: Buffer) => {
      this.closeInfo = { code, reason: reason.toString() };
      this.settleTerminal();
    });
  }

  /** The accepted handshake. Reading it before the handshake completes is a test error. */
  get ready(): BridgeReady {
    if (!this.readyMessage) throw new Error("the bridge handshake did not complete");
    return this.readyMessage;
  }

  get generation(): number {
    return this.ready.generation;
  }

  get open(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  /** Answers every command this test does not pull with waitForCommand. */
  onCommand(handler: (command: BridgeCommand) => void): void {
    this.handlers.add(handler);
    this.drain();
  }

  /** The next command that matches, or a rejection naming the close code or the deadline. */
  async waitForCommand(
    predicate: (command: BridgeCommand) => boolean,
    timeoutMs: number = this.timeoutMs,
  ): Promise<BridgeCommand> {
    const waitingFor = "a bridge command";
    const held = this.commands.findIndex(predicate);
    if (held >= 0) return this.commands.splice(held, 1)[0]!;
    return await this.guard<BridgeCommand>(waitingFor, timeoutMs, (settle) => {
      const waiter: CommandWaiter = {
        predicate,
        settle: (command) => {
          this.waiters.delete(waiter);
          settle(command);
        },
      };
      this.waiters.add(waiter);
    });
  }

  /** Sends the current course connections for the accepted generation, as the extension does. */
  updateBindings(bindings: readonly BridgeBinding[]): void {
    if (!this.open) return;
    this.socket.send(serializeBridgeMessage({
      schema: BRIDGE_SCHEMAS.bindings,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      generation: this.generation,
      bindings,
      sentAt: Date.now(),
    }));
  }

  /** Sends the successful result for one command. A closed socket drops it, as the extension does. */
  respond(command: BridgeCommand, result: JsonObject): void {
    this.send(command, { ok: true, result });
  }

  /**
   * Sends the refusal or uncertain ending for one command, with the evidence
   * the extension returns alongside it: a failed write still carries the
   * retained read descriptor Morrow needs to check the change later.
   */
  respondProblem(command: BridgeCommand, problem: BridgeProblem, result?: JsonObject): void {
    this.send(command, { ok: false, problem, ...(result ? { result } : {}) });
  }

  /** Resolves when the bridge closes, with the close code and reason. */
  async closed(timeoutMs: number = this.timeoutMs): Promise<BridgeCloseInfo> {
    if (this.closeInfo) return this.closeInfo;
    return await new Promise<BridgeCloseInfo>((resolve, reject) => {
      const timer = setTimeout(() => reject(new BridgeTimeoutError("the bridge close", timeoutMs)), timeoutMs);
      timer.unref?.();
      this.socket.once("close", (code: number, reason: Buffer) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString() });
      });
    });
  }

  /** Closes the bridge and waits for the close to land. Safe to call twice. */
  async close(timeoutMs: number = this.timeoutMs): Promise<BridgeCloseInfo> {
    if (this.closeInfo) return this.closeInfo;
    const closed = this.closed(timeoutMs);
    if (this.socket.readyState !== WebSocket.CLOSING) this.socket.close();
    return await closed;
  }

  /** Waits for the TCP connection, rejecting on a close, an error, or the deadline. */
  async opened(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await this.guard<void>("the bridge connection", this.timeoutMs, (settle) => {
      this.socket.once("open", () => settle());
    });
  }

  /** Waits for morrow.bridge.ready.v1, rejecting on a refusal close with its code and reason. */
  async waitForReady(): Promise<BridgeReady> {
    if (this.readyMessage) return this.readyMessage;
    const ready = await this.guard<BridgeReady>(BRIDGE_SCHEMAS.ready, this.timeoutMs, (settle) => {
      this.readySettle = settle;
    });
    return ready;
  }

  private send(
    command: BridgeCommand,
    ending: { ok: true; result: JsonObject } | { ok: false; problem: BridgeProblem; result?: JsonObject },
  ): void {
    if (!this.open) return;
    this.socket.send(serializeBridgeMessage({
      schema: BRIDGE_SCHEMAS.result,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: command.requestId,
      operationId: command.operationId,
      generation: command.generation,
      completedAt: Date.now(),
      ...ending,
    }));
  }

  private receive(text: string): void {
    let value: unknown;
    try {
      value = parseBridgeJson(text);
    } catch {
      return;
    }
    if (!isJsonObject(value)) return;
    if (value.schema === BRIDGE_SCHEMAS.ready) {
      this.readyMessage = value as unknown as BridgeReady;
      const settle = this.readySettle;
      this.readySettle = null;
      settle?.(this.readyMessage);
      return;
    }
    if (value.schema !== BRIDGE_SCHEMAS.command) return;
    this.commands.push(value as unknown as BridgeCommand);
    this.drain();
  }

  /** A waiting predicate claims a command first; otherwise every registered handler sees it. */
  private drain(): void {
    while (this.commands.length > 0) {
      const command = this.commands[0]!;
      const waiter = [...this.waiters].find((candidate) => candidate.predicate(command));
      if (waiter) {
        this.commands.shift();
        waiter.settle(command);
        continue;
      }
      if (this.handlers.size === 0) return;
      this.commands.shift();
      for (const handler of this.handlers) handler(command);
    }
  }

  private terminalError(waitingFor: string): Error | null {
    if (this.socketError) return this.socketError;
    if (this.closeInfo) return new BridgeClosedError(waitingFor, this.closeInfo);
    return null;
  }

  private settleTerminal(): void {
    for (const stall of [...this.stalls]) {
      const error = this.terminalError(stall.waitingFor);
      if (error) stall.reject(error);
    }
  }

  private async guard<T>(
    waitingFor: string,
    timeoutMs: number,
    register: (settle: (value: T) => void) => void,
  ): Promise<T> {
    const failure = this.terminalError(waitingFor);
    if (failure) throw failure;
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let stall: Stall | null = null;
      const finish = (act: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (stall) this.stalls.delete(stall);
        act();
      };
      timer = setTimeout(() => finish(() => reject(new BridgeTimeoutError(waitingFor, timeoutMs))), timeoutMs);
      timer.unref?.();
      stall = { waitingFor, reject: (error) => finish(() => reject(error)) };
      this.stalls.add(stall);
      register((value) => finish(() => resolve(value)));
    });
  }
}

/**
 * Opens one bridge connection and completes the handshake. A refused hello
 * rejects here with the close code, so a wrong digest, token, runtime revision
 * or extension id fails the test inside the deadline instead of hanging.
 */
export async function connectBridgeTestClient(options: BridgeTestClientOptions): Promise<BridgeTestClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${options.port}${BRIDGE_PATH}`, {
    origin: options.origin ?? `chrome-extension://${options.extensionId}`,
  });
  const client = new BridgeTestClient(socket, options.timeoutMs ?? BRIDGE_TEST_WAIT_MS);
  try {
    await client.opened();
    socket.send(serializeBridgeMessage({
      schema: BRIDGE_SCHEMAS.hello,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      token: options.token,
      extensionId: options.extensionId,
      runtimeRevision: options.runtimeRevision ?? BRIDGE_TEST_RUNTIME_REVISION,
      catalogDigest: options.catalogDigest,
      bindings: options.bindings ?? [],
      sentAt: Date.now(),
    }));
    await client.waitForReady();
  } catch (error) {
    socket.terminate();
    throw error;
  }
  return client;
}
