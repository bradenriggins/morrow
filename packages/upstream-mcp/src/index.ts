import { Client } from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import {
  isJsonObject,
  normalizeAnnotations,
  normalizeInputSchema,
  normalizeSourceId,
  normalizeToolName,
  sha256Text,
  type JsonObject,
  type UpstreamTool,
} from "@morrow/contracts";

export interface StdioUpstreamOptions {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly priority?: number;
  readonly required?: boolean;
}

export interface StdioUpstreamHealth {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
  readonly connected: boolean;
  readonly toolCount: number;
  readonly errorDigest?: string;
}

export class StdioMcpUpstream {
  readonly id: string;
  readonly label: string;
  readonly priority: number;
  readonly required: boolean;

  private readonly options: StdioUpstreamOptions;
  private client: Client | null = null;
  private tools: readonly UpstreamTool[] = [];
  private errorDigest: string | undefined;

  constructor(options: StdioUpstreamOptions) {
    this.options = options;
    this.id = normalizeSourceId(options.id);
    this.label = options.label.trim() || this.id;
    this.priority = options.priority ?? 0;
    this.required = options.required ?? true;
  }

  async connect(): Promise<readonly UpstreamTool[]> {
    if (this.client) return this.tools;

    const client = new Client({
      name: `morrow-upstream-${this.id}`,
      version: "1.0.0-alpha.1",
    });

    const transport = new StdioClientTransport({
      command: this.options.command,
      args: [...(this.options.args ?? [])],
      env: {
        ...getDefaultEnvironment(),
        ...(this.options.env ?? {}),
      },
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
    });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
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
      });

      this.client = client;
      this.tools = normalized;
      this.errorDigest = undefined;
      return this.tools;
    } catch (error) {
      this.errorDigest = sha256Text(error instanceof Error ? `${error.name}:${error.message}` : String(error));
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (!this.client) {
      throw new Error(`Upstream ${this.id} is not connected`);
    }
    return this.client.callTool({
      name: normalizeToolName(name),
      arguments: { ...args },
    });
  }

  health(): StdioUpstreamHealth {
    return {
      id: this.id,
      label: this.label,
      required: this.required,
      connected: this.client !== null,
      toolCount: this.tools.length,
      ...(this.errorDigest ? { errorDigest: this.errorDigest } : {}),
    };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.tools = [];
    if (client) await client.close();
  }
}
