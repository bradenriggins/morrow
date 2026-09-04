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
  sha256Text,
  upstreamCatalogDigest,
  type GatewaySourceHealth,
  type JsonObject,
  type SourceAttestationHealth,
  type UpstreamTool,
} from "@morrow/contracts";
import { StrictStdioClientTransport } from "./strict-stdio.js";

export interface StdioUpstreamOptions {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly priority?: number;
  readonly required?: boolean;
  readonly expectedToolCount?: number;
  readonly expectedCatalogDigest?: string;
  readonly sourceAttestation?: SourceAttestationHealth;
}

export type StdioUpstreamHealth = GatewaySourceHealth;

const UPSTREAM_STDERR_LIMIT = 8_000;
const UPSTREAM_MAX_BUFFER_SIZE = 1_000_000;

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

export class StdioMcpUpstream {
  readonly id: string;
  readonly label: string;
  readonly priority: number;
  readonly required: boolean;

  private readonly options: StdioUpstreamOptions;
  private readonly expectedToolCount: number | undefined;
  private readonly expectedCatalogDigest: string | undefined;
  private readonly sourceAttestation: SourceAttestationHealth | undefined;
  private client: Client | null = null;
  private tools: readonly UpstreamTool[] = [];
  private catalogDigest: string | undefined;
  private errorDigest: string | undefined;

  constructor(options: StdioUpstreamOptions) {
    this.options = options;
    this.id = normalizeSourceId(options.id);
    this.label = options.label.trim() || this.id;
    this.priority = options.priority ?? 0;
    this.required = options.required ?? true;
    this.expectedToolCount = exactExpectedToolCount(options.expectedToolCount);
    this.expectedCatalogDigest = exactExpectedCatalogDigest(options.expectedCatalogDigest);
    this.sourceAttestation = options.sourceAttestation;
  }

  async connect(): Promise<readonly UpstreamTool[]> {
    if (this.client) return this.tools;

    const client = new Client({
      name: `morrow-upstream-${this.id}`,
      version: "1.0.0-alpha.1",
    });
    let protocolError: Error | undefined;
    client.onerror = (error) => {
      protocolError = error;
    };

    const transport = new StrictStdioClientTransport({
      command: this.options.command,
      args: [...(this.options.args ?? [])],
      env: {
        ...getDefaultEnvironment(),
        ...(this.options.env ?? {}),
      },
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
      maxBufferSize: UPSTREAM_MAX_BUFFER_SIZE,
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length >= UPSTREAM_STDERR_LIMIT) return;
      stderr += chunk.toString().slice(0, UPSTREAM_STDERR_LIMIT - stderr.length);
    });

    try {
      await client.connect(transport);
      if (protocolError) throw protocolError;
      const listed = await client.listTools();
      if (protocolError) throw protocolError;
      const normalized = listed.tools.map((tool): UpstreamTool => {
        const raw = tool as unknown as JsonObject;
        const annotations = normalizeAnnotations(raw.annotations);
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
        };
      }).sort((left, right) => compareAscii(left.name, right.name));

      for (let index = 1; index < normalized.length; index += 1) {
        if (normalized[index - 1]!.name === normalized[index]!.name) {
          throw new Error(`Upstream ${this.id} published duplicate tool ${normalized[index]!.name}`);
        }
      }

      const catalogDigest = upstreamCatalogDigest(this.id, normalized);
      if (
        this.expectedToolCount !== undefined
        && normalized.length !== this.expectedToolCount
      ) {
        throw new Error(
          `Upstream ${this.id} published ${normalized.length} tools, not the attested ${this.expectedToolCount}.`,
        );
      }
      if (
        this.expectedCatalogDigest
        && catalogDigest !== this.expectedCatalogDigest
      ) {
        throw new Error(
          `Upstream ${this.id} catalog digest ${catalogDigest} does not match the configured attestation.`,
        );
      }

      this.client = client;
      this.tools = normalized;
      this.catalogDigest = catalogDigest;
      this.errorDigest = undefined;
      return this.tools;
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
      this.errorDigest = sha256Text(stderr ? `${detail}\n${stderr}` : detail);
      this.catalogDigest = undefined;
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<unknown> {
    if (!this.client) {
      throw new Error(`Upstream ${this.id} is not connected`);
    }
    return this.client.callTool({
      name: normalizeToolName(name),
      arguments: { ...args },
    }, options);
  }

  health(): StdioUpstreamHealth {
    const hasCatalogExpectation = this.expectedToolCount !== undefined
      || this.expectedCatalogDigest !== undefined;
    return {
      id: this.id,
      label: this.label,
      required: this.required,
      connected: this.client !== null,
      toolCount: this.tools.length,
      ...(this.catalogDigest ? { catalogDigest: this.catalogDigest } : {}),
      ...(this.expectedToolCount !== undefined
        ? { expectedToolCount: this.expectedToolCount }
        : {}),
      ...(this.expectedCatalogDigest
        ? { expectedCatalogDigest: this.expectedCatalogDigest }
        : {}),
      ...(hasCatalogExpectation
        ? {
            catalogAttested: this.client !== null
              && (this.expectedToolCount === undefined || this.tools.length === this.expectedToolCount)
              && (this.expectedCatalogDigest === undefined || this.catalogDigest === this.expectedCatalogDigest),
          }
        : {}),
      ...(this.sourceAttestation ? { sourceAttestation: this.sourceAttestation } : {}),
      ...(this.errorDigest ? { errorDigest: this.errorDigest } : {}),
    };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.tools = [];
    this.catalogDigest = undefined;
    if (client) await client.close();
  }
}
