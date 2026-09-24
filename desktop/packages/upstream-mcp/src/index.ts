import { Client } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import {
  isJsonObject,
  normalizeAnnotations,
  normalizeInputSchema,
  normalizeSourceId,
  normalizeToolName,
  parseSourceCapabilityMetadata,
  sha256Text,
  upstreamCatalogDigest,
  type CatalogTruthHealth,
  type GatewaySourceHealth,
  type JsonObject,
  type SourceAttestationHealth,
  type UpstreamReconnectHealth,
  type UpstreamTool,
} from "@morrow/contracts";
import { StrictStdioClientTransport } from "./strict-stdio.js";

export interface UpstreamSupervisionOptions {
  readonly startupAttempts?: number;
  readonly reconnectAttempts?: number;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

export interface StdioUpstreamLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface PreparedStdioUpstreamLaunch {
  readonly launch: StdioUpstreamLaunch;
  readonly sourceAttestation?: SourceAttestationHealth;
}

export interface StdioUpstreamOptions {
  readonly internalSourceCapability?: string;
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stderr?: "inherit" | "ignore";
  readonly priority?: number;
  readonly required?: boolean;
  readonly expectedToolCount?: number;
  readonly expectedCatalogDigest?: string;
  readonly sourceAttestation?: SourceAttestationHealth;
  readonly catalogTruth?: CatalogTruthHealth;
  readonly supervision?: UpstreamSupervisionOptions;
  readonly now?: () => Date;
  readonly beforeConnect?: () => void | Promise<void>;
  readonly prepareLaunch?: (
    launch: StdioUpstreamLaunch,
  ) => PreparedStdioUpstreamLaunch | Promise<PreparedStdioUpstreamLaunch>;
}

export interface UpstreamCallOptions {
  readonly safeToRetry?: boolean;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export type StdioUpstreamHealth = GatewaySourceHealth;

/** The source was not connected, so this call sent nothing and was not retried. */
export class UpstreamNotDispatchedError extends Error {
  constructor(readonly upstreamId: string) {
    super(`Upstream ${upstreamId} disconnected before dispatch`);
    this.name = "UpstreamNotDispatchedError";
  }
}

const UPSTREAM_STDERR_LIMIT = 8_000;
const UPSTREAM_MAX_BUFFER_SIZE = 16 * 1024 * 1024;
interface ExactSupervision {
  readonly startupAttempts: number;
  readonly reconnectAttempts: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactExpectedToolCount(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > 5_000) {
    throw new TypeError("expected upstream tool count must be a whole number from 1 through 5000");
  }
  return value;
}

function exactExpectedCatalogDigest(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new TypeError("expected upstream catalog digest must be a SHA-256 digest");
  }
  return normalized;
}

function exactInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new TypeError(`${label} must be a whole number from ${minimum} through ${maximum}`);
  }
  return selected;
}

function exactSupervision(value: UpstreamSupervisionOptions | undefined): ExactSupervision {
  const supervision = {
    startupAttempts: exactInteger(value?.startupAttempts, 1, 1, 8, "startupAttempts"),
    reconnectAttempts: exactInteger(value?.reconnectAttempts, 1, 1, 8, "reconnectAttempts"),
    initialBackoffMs: exactInteger(value?.initialBackoffMs, 100, 1, 30_000, "initialBackoffMs"),
    maxBackoffMs: exactInteger(value?.maxBackoffMs, 2_000, 1, 60_000, "maxBackoffMs"),
  };
  if (supervision.maxBackoffMs < supervision.initialBackoffMs) {
    throw new TypeError("maxBackoffMs must be greater than or equal to initialBackoffMs");
  }
  return supervision;
}

function closedError(id: string): Error {
  return new Error(`Upstream ${id} is closed`);
}

function abortedError(id: string, signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`Upstream ${id} connection cancelled`);
}

function wait(milliseconds: number, unref: boolean, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Upstream reconnect cancelled"));
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("Upstream reconnect cancelled"));
    };
    const timer = setTimeout(finish, milliseconds);
    if (unref) timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

interface ProvisionalConnection {
  readonly client: Client;
  readonly transport: StrictStdioClientTransport;
  closePromise?: Promise<void>;
}

interface ConnectionRun {
  readonly controller: AbortController;
  phase: "preparing" | "backoff" | "initializing" | "established";
  provisional: ProvisionalConnection | null;
}

export class StdioMcpUpstream {
  readonly id: string;
  readonly label: string;
  readonly priority: number;
  readonly required: boolean;

  private readonly options: StdioUpstreamOptions;
  private readonly expectedToolCount: number | undefined;
  private readonly expectedCatalogDigest: string | undefined;
  private sourceAttestation: SourceAttestationHealth | undefined;
  private readonly catalogTruth: CatalogTruthHealth | undefined;
  private readonly supervision: ExactSupervision;
  private readonly supervisionEnabled: boolean;
  private readonly now: () => Date;
  private client: Client | null = null;
  private tools: readonly UpstreamTool[] = [];
  private catalogDigest: string | undefined;
  private errorDigest: string | undefined;
  private connectionPromise: Promise<readonly UpstreamTool[]> | null = null;
  private connectionRun: ConnectionRun | null = null;
  private closePromise: Promise<void> | null = null;
  private closed = false;
  private connectionGeneration = 0;
  private startupAttempts = 0;
  private reconnectAttempt = 0;
  private reconnectState: UpstreamReconnectHealth["state"] = "idle";
  private nextRetryAt: string | undefined;
  private lastConnectedAt: string | undefined;
  private lastDisconnectedAt: string | undefined;

  constructor(options: StdioUpstreamOptions) {
    this.options = options;
    this.id = normalizeSourceId(options.id);
    this.label = options.label.trim() || this.id;
    this.priority = options.priority ?? 0;
    this.required = options.required ?? true;
    this.expectedToolCount = exactExpectedToolCount(options.expectedToolCount);
    this.expectedCatalogDigest = exactExpectedCatalogDigest(options.expectedCatalogDigest);
    this.sourceAttestation = options.sourceAttestation;
    this.catalogTruth = options.catalogTruth;
    this.supervision = exactSupervision(options.supervision);
    this.supervisionEnabled = options.supervision !== undefined;
    this.now = options.now ?? (() => new Date());
  }

  private backoff(attempt: number): number {
    return Math.min(
      this.supervision.maxBackoffMs,
      this.supervision.initialBackoffMs * (2 ** Math.max(0, attempt - 1)),
    );
  }

  private normalizeTools(listed: Awaited<ReturnType<Client["listTools"]>>): readonly UpstreamTool[] {
    const normalized = listed.tools.map((tool): UpstreamTool => {
      const raw = tool as unknown as JsonObject;
      const annotations = normalizeAnnotations(raw.annotations);
      const metadata = isJsonObject(raw._meta)
        ? parseSourceCapabilityMetadata(raw._meta["io.morrow/capability"])
        : undefined;
      return {
        name: normalizeToolName(raw.name),
        ...(typeof raw.title === "string" && raw.title.trim() ? { title: raw.title.trim() } : {}),
        ...(typeof raw.description === "string" && raw.description.trim()
          ? { description: raw.description.trim() }
          : {}),
        inputSchema: normalizeInputSchema(raw.inputSchema),
        ...(isJsonObject(raw.outputSchema)
          ? { outputSchema: normalizeInputSchema(raw.outputSchema) }
          : {}),
        ...(annotations ? { annotations } : {}),
        ...(metadata ? { capability: metadata } : {}),
      };
    }).sort((left, right) => compareAscii(left.name, right.name));

    for (let index = 1; index < normalized.length; index += 1) {
      if (normalized[index - 1]!.name === normalized[index]!.name) {
        throw new Error(`Upstream ${this.id} published duplicate tool ${normalized[index]!.name}`);
      }
    }
    return normalized;
  }

  private assertCatalog(tools: readonly UpstreamTool[]): string {
    const catalogDigest = upstreamCatalogDigest(this.id, tools);
    if (this.expectedToolCount !== undefined && tools.length !== this.expectedToolCount) {
      throw new Error(
        `Upstream ${this.id} published ${tools.length} tools, not the attested ${this.expectedToolCount}.`,
      );
    }
    if (this.expectedCatalogDigest && catalogDigest !== this.expectedCatalogDigest) {
      throw new Error(
        `Upstream ${this.id} catalog digest ${catalogDigest} does not match the configured attestation.`,
      );
    }
    return catalogDigest;
  }

  private assertConnectionOpen(run: ConnectionRun): void {
    if (this.closed || run.controller.signal.aborted) throw closedError(this.id);
  }

  private closeProvisional(connection: ProvisionalConnection): Promise<void> {
    if (connection.closePromise) return connection.closePromise;
    connection.client.onclose = undefined;
    connection.closePromise = (async () => {
      let clientError: unknown;
      try {
        await connection.client.close();
      } catch (error) {
        clientError = error;
      }
      try {
        await connection.transport.close();
      } catch (error) {
        if (clientError === undefined) clientError = error;
      }
      if (clientError !== undefined) throw clientError;
    })();
    return connection.closePromise;
  }

  private async connectOnce(run: ConnectionRun): Promise<readonly UpstreamTool[]> {
    this.assertConnectionOpen(run);
    await this.options.beforeConnect?.();
    this.assertConnectionOpen(run);
    this.reconnectState = "connecting";
    this.nextRetryAt = undefined;
    const client = new Client({
      name: `morrow-upstream-${this.id}`,
      version: "1.0.0",
    });
    let protocolError: Error | undefined;
    client.onerror = (error) => {
      protocolError = error;
    };
    let connectionClosed = false;
    client.onclose = () => {
      connectionClosed = true;
      this.handleClientClose(client);
    };

    const baseLaunch: StdioUpstreamLaunch = {
      command: this.options.command,
      args: [...(this.options.args ?? [])],
      env: {
        ...getDefaultEnvironment(),
        ...(this.options.env ?? {}),
        ...(this.options.internalSourceCapability ? { MORROW_INTERNAL_SOURCE_CAPABILITY: this.options.internalSourceCapability } : {}),
      },
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
    };
    const prepared = this.options.prepareLaunch
      ? await this.options.prepareLaunch(baseLaunch)
      : { launch: baseLaunch };
    this.assertConnectionOpen(run);
    if (prepared.sourceAttestation) this.sourceAttestation = prepared.sourceAttestation;
    const transport = new StrictStdioClientTransport({
      command: prepared.launch.command,
      args: [...prepared.launch.args],
      env: { ...prepared.launch.env },
      ...(prepared.launch.cwd ? { cwd: prepared.launch.cwd } : {}),
      maxBufferSize: UPSTREAM_MAX_BUFFER_SIZE,
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length >= UPSTREAM_STDERR_LIMIT) return;
      stderr += chunk.toString().slice(0, UPSTREAM_STDERR_LIMIT - stderr.length);
    });
    const provisional: ProvisionalConnection = { client, transport };
    run.provisional = provisional;
    run.phase = "initializing";

    try {
      await client.connect(transport, { signal: run.controller.signal });
      if (protocolError) throw protocolError;
      const listed = await client.listTools(undefined, { signal: run.controller.signal });
      if (protocolError) throw protocolError;
      const normalized = this.normalizeTools(listed);
      const catalogDigest = this.assertCatalog(normalized);
      if (connectionClosed || this.closed || run.controller.signal.aborted) {
        throw new Error(`Upstream ${this.id} closed during initialization`);
      }
      this.client = client;
      run.provisional = null;
      run.phase = "established";
      this.tools = normalized;
      this.catalogDigest = catalogDigest;
      this.errorDigest = undefined;
      this.connectionGeneration += 1;
      this.reconnectAttempt = 0;
      this.reconnectState = "idle";
      this.lastConnectedAt = this.now().toISOString();
      return this.tools;
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
      this.errorDigest = sha256Text(stderr ? `${detail}\n${stderr}` : detail);
      this.catalogDigest = undefined;
      await this.closeProvisional(provisional).catch(() => undefined);
      if (run.provisional === provisional) run.provisional = null;
      if (this.closed || run.controller.signal.aborted) throw closedError(this.id);
      throw error;
    }
  }

  private async runConnectionAttempts(
    maximum: number,
    reconnect: boolean,
    run: ConnectionRun,
  ): Promise<readonly UpstreamTool[]> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maximum; attempt += 1) {
      this.assertConnectionOpen(run);
      if (reconnect || attempt > 1) {
        const delay = this.backoff(attempt);
        run.phase = "backoff";
        this.reconnectState = "waiting";
        this.reconnectAttempt = attempt;
        this.nextRetryAt = new Date(this.now().getTime() + delay).toISOString();
        await wait(delay, reconnect, run.controller.signal);
        this.assertConnectionOpen(run);
      }
      if (!reconnect) this.startupAttempts = attempt;
      run.phase = "preparing";
      try {
        return await this.connectOnce(run);
      } catch (error) {
        if (this.closed || run.controller.signal.aborted) throw closedError(this.id);
        lastError = error;
      }
    }
    this.assertConnectionOpen(run);
    this.reconnectState = "exhausted";
    this.reconnectAttempt = maximum;
    this.nextRetryAt = undefined;
    throw lastError;
  }

  private startConnection(reconnect: boolean, signal?: AbortSignal): Promise<readonly UpstreamTool[]> {
    if (this.closed) return Promise.reject(closedError(this.id));
    if (this.client) return Promise.resolve(this.tools);
    if (this.connectionPromise) return this.connectionPromise;
    if (signal?.aborted) return Promise.reject(abortedError(this.id, signal));
    const maximum = reconnect
      ? this.supervision.reconnectAttempts
      : this.supervision.startupAttempts;
    const run: ConnectionRun = {
      controller: new AbortController(),
      phase: "preparing",
      provisional: null,
    };
    this.connectionRun = run;
    let rejectAborted: ((error: Error) => void) | null = null;
    const onAbort = () => {
      const error = abortedError(this.id, signal!);
      run.controller.abort(error);
      rejectAborted?.(error);
    };
    const attempt = this.runConnectionAttempts(maximum, reconnect, run);
    const pending = signal
      ? Promise.race([
          attempt,
          new Promise<never>((_resolve, reject) => {
            rejectAborted = reject;
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        ])
      : attempt;
    if (signal?.aborted) onAbort();
    this.connectionPromise = pending;
    const finishAttempt = () => {
      signal?.removeEventListener("abort", onAbort);
      rejectAborted = null;
      if (this.connectionRun === run) this.connectionRun = null;
    };
    void attempt.then(finishAttempt, finishAttempt);
    const finishPending = () => {
      if (this.connectionPromise === pending) this.connectionPromise = null;
    };
    void pending.then(finishPending, finishPending);
    return pending;
  }

  private handleClientClose(client: Client): void {
    if (this.client !== client) return;
    this.client = null;
    this.lastDisconnectedAt = this.now().toISOString();
    this.errorDigest = sha256Text("upstream_connection_closed");
    if (!this.closed && this.supervisionEnabled) {
      void this.startConnection(true).catch(() => undefined);
    }
  }

  private async invalidateClient(client: Client): Promise<void> {
    if (this.client === client) {
      this.client = null;
      this.lastDisconnectedAt = this.now().toISOString();
    }
    await client.close().catch(() => undefined);
    if (!this.closed && this.supervisionEnabled && !this.connectionPromise) {
      void this.startConnection(true).catch(() => undefined);
    }
  }

  async connect(options: { readonly signal?: AbortSignal } = {}): Promise<readonly UpstreamTool[]> {
    if (this.client) return this.tools;
    return this.startConnection(false, options.signal);
  }

  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    options: UpstreamCallOptions = {},
  ): Promise<unknown> {
    let client = this.client;
    if (!client) {
      if (!options.safeToRetry) throw new UpstreamNotDispatchedError(this.id);
      await this.startConnection(true);
      client = this.client;
    }
    if (!client) throw new Error(`Upstream ${this.id} is not connected`);

    const requestOptions = {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs === undefined ? {} : {
        timeout: options.timeoutMs,
        maxTotalTimeout: options.timeoutMs,
      }),
    };
    try {
      return await client.callTool({
        name: normalizeToolName(name),
        arguments: { ...args },
        ...(this.options.internalSourceCapability ? { _meta: { "io.morrow/internal-source-capability": this.options.internalSourceCapability } } : {}),
      }, requestOptions);
    } catch (error) {
      if (this.client === client || options.signal?.aborted) throw error;
      await this.invalidateClient(client);
      if (!options.safeToRetry) throw error;
      await this.startConnection(true);
      const retryClient = this.client;
      if (!retryClient) throw error;
      return retryClient.callTool({
        name: normalizeToolName(name),
        arguments: { ...args },
        ...(this.options.internalSourceCapability ? { _meta: { "io.morrow/internal-source-capability": this.options.internalSourceCapability } } : {}),
      }, requestOptions);
    }
  }

  health(): StdioUpstreamHealth {
    const hasCatalogExpectation = this.expectedToolCount !== undefined
      || this.expectedCatalogDigest !== undefined;
    const reconnect: UpstreamReconnectHealth = {
      schema: "morrow.upstream-reconnect.health.v1",
      state: this.reconnectState,
      attempt: this.reconnectAttempt,
      maxAttempts: this.supervision.reconnectAttempts,
      startupAttempts: this.startupAttempts,
      ...(this.nextRetryAt ? { nextRetryAt: this.nextRetryAt } : {}),
      ...(this.lastConnectedAt ? { lastConnectedAt: this.lastConnectedAt } : {}),
      ...(this.lastDisconnectedAt ? { lastDisconnectedAt: this.lastDisconnectedAt } : {}),
    };
    return {
      id: this.id,
      label: this.label,
      required: this.required,
      connected: this.client !== null,
      toolCount: this.tools.length,
      ...(this.catalogDigest ? { catalogDigest: this.catalogDigest } : {}),
      ...(this.expectedToolCount !== undefined ? { expectedToolCount: this.expectedToolCount } : {}),
      ...(this.expectedCatalogDigest ? { expectedCatalogDigest: this.expectedCatalogDigest } : {}),
      ...(hasCatalogExpectation
        ? {
            catalogAttested: this.client !== null
              && (this.expectedToolCount === undefined || this.tools.length === this.expectedToolCount)
              && (this.expectedCatalogDigest === undefined || this.catalogDigest === this.expectedCatalogDigest),
          }
        : {}),
      ...(this.sourceAttestation ? { sourceAttestation: this.sourceAttestation } : {}),
      ...(this.catalogTruth ? { catalogTruth: this.catalogTruth } : {}),
      connectionGeneration: this.connectionGeneration,
      reconnect,
      ...(this.errorDigest ? { errorDigest: this.errorDigest } : {}),
    };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.reconnectState = "closed";
    this.nextRetryAt = undefined;
    const client = this.client;
    const run = this.connectionRun;
    const provisional = run?.provisional ?? null;
    const pendingConnection = this.connectionPromise;
    this.client = null;
    this.tools = [];
    this.catalogDigest = undefined;
    run?.controller.abort(closedError(this.id));
    const canJoinConnection = run?.phase !== "preparing";
    this.closePromise = (async () => {
      if (client) {
        client.onclose = undefined;
        await client.close();
      }
      if (provisional) await this.closeProvisional(provisional);
      if (canJoinConnection) await pendingConnection?.catch(() => undefined);
    })();
    return this.closePromise;
  }
}
