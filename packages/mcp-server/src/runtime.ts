import {
  sha256Json,
  sha256Text,
  type CatalogSnapshot,
  type CatalogSource,
  type CatalogTool,
  type GatewayHealth,
  type JsonObject,
  type ToolAnnotations,
} from "@morrow/contracts";
import {
  mergeCatalog,
  normalizeUpstreamResult,
  safeUpstreamFailure,
} from "@morrow/gateway-core";
import { StdioMcpUpstream } from "@morrow/upstream-mcp";
import type { GatewayConfig } from "./config.js";

export interface CatalogSearchInput {
  readonly query?: string;
  readonly source?: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface CatalogSearchTool {
  readonly publicName: string;
  readonly upstreamId: string;
  readonly upstreamName: string;
  readonly title?: string;
  readonly description?: string;
  readonly descriptionSha256?: string;
  readonly inputSchemaSha256: string;
  readonly outputSchemaSha256?: string;
  readonly annotations?: ToolAnnotations;
}

export interface CatalogSearchResult {
  readonly schema: "morrow.catalog.search.v1";
  readonly catalogDigest: string;
  readonly totalMatches: number;
  readonly offset: number;
  readonly returned: number;
  readonly nextOffset: number | null;
  readonly tools: readonly CatalogSearchTool[];
  readonly collisionCount: number;
  readonly collisions: CatalogSnapshot["collisions"];
  readonly excludedCount: number;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function truncateText(value: string | undefined, maximum: number): string | undefined {
  if (!value) return undefined;
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function projectCatalogTool(tool: CatalogTool): CatalogSearchTool {
  const description = truncateText(tool.description, 800);
  const title = truncateText(tool.title, 200);
  return {
    publicName: tool.publicName,
    upstreamId: tool.upstreamId,
    upstreamName: tool.upstreamName,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(tool.description ? { descriptionSha256: sha256Text(tool.description) } : {}),
    inputSchemaSha256: sha256Json(tool.inputSchema),
    ...(tool.outputSchema ? { outputSchemaSha256: sha256Json(tool.outputSchema) } : {}),
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  };
}

export class GatewayRuntime {
  readonly config: GatewayConfig;
  readonly catalog: CatalogSnapshot;

  private readonly upstreams: ReadonlyMap<string, StdioMcpUpstream>;
  private readonly toolByPublicName: ReadonlyMap<string, CatalogTool>;

  private constructor(
    config: GatewayConfig,
    upstreams: ReadonlyMap<string, StdioMcpUpstream>,
    catalog: CatalogSnapshot,
  ) {
    this.config = config;
    this.upstreams = upstreams;
    this.catalog = catalog;
    this.toolByPublicName = new Map(catalog.tools.map((tool) => [tool.publicName, tool]));
  }

  static async connect(config: GatewayConfig): Promise<GatewayRuntime> {
    const upstreams = new Map<string, StdioMcpUpstream>();
    const sources: CatalogSource[] = [];

    for (const upstreamConfig of [...config.upstreams].sort((left, right) => (
      right.priority - left.priority || compareAscii(left.id, right.id)
    ))) {
      const upstream = new StdioMcpUpstream({
        id: upstreamConfig.id,
        label: upstreamConfig.label,
        command: upstreamConfig.command,
        args: upstreamConfig.args,
        ...(upstreamConfig.cwd ? { cwd: upstreamConfig.cwd } : {}),
        env: upstreamConfig.env,
        priority: upstreamConfig.priority,
        required: upstreamConfig.required,
      });
      upstreams.set(upstream.id, upstream);

      try {
        const tools = await upstream.connect();
        sources.push({
          id: upstream.id,
          label: upstream.label,
          priority: upstream.priority,
          tools,
        });
      } catch (error) {
        if (upstream.required) {
          await Promise.allSettled([...upstreams.values()].map((candidate) => candidate.close()));
          throw new Error(
            `Required upstream ${upstream.id} failed to connect`,
            { cause: error },
          );
        }
      }
    }

    const catalog = mergeCatalog(sources, {
      excludePrefixes: config.filters.excludePrefixes,
      excludeNames: config.filters.excludeNames,
    });

    if (catalog.tools.length > config.maxCatalogTools) {
      await Promise.allSettled([...upstreams.values()].map((candidate) => candidate.close()));
      throw new Error(
        `Catalog contains ${catalog.tools.length} tools, above maxCatalogTools=${config.maxCatalogTools}`,
      );
    }

    return new GatewayRuntime(config, upstreams, catalog);
  }

  health(): GatewayHealth {
    const sources = [...this.upstreams.values()].map((upstream) => upstream.health());
    return {
      schema: "morrow.health.v1",
      version: "1.0.0-alpha.1",
      ready: sources.every((source) => !source.required || source.connected),
      profile: this.config.profile,
      catalogDigest: this.catalog.digest,
      publicToolCount: this.catalog.tools.length,
      collisionCount: this.catalog.collisions.length,
      excludedToolCount: this.catalog.excluded.length,
      sources,
    };
  }

  searchCatalog(input: CatalogSearchInput = {}): CatalogSearchResult {
    const query = input.query?.trim().toLowerCase() ?? "";
    const source = input.source?.trim().toLowerCase() ?? "";
    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
    const matches = this.catalog.tools.filter((tool) => {
      if (source && tool.upstreamId !== source) return false;
      if (!query) return true;
      return [tool.publicName, tool.upstreamName, tool.title, tool.description]
        .filter((value): value is string => typeof value === "string")
        .some((value) => value.toLowerCase().includes(query));
    });
    const page = matches.slice(offset, offset + limit);
    const nextOffset = offset + page.length < matches.length
      ? offset + page.length
      : null;

    return {
      schema: "morrow.catalog.search.v1",
      catalogDigest: this.catalog.digest,
      totalMatches: matches.length,
      offset,
      returned: page.length,
      nextOffset,
      tools: page.map(projectCatalogTool),
      collisionCount: this.catalog.collisions.length,
      collisions: this.catalog.collisions.slice(0, 50),
      excludedCount: this.catalog.excluded.length,
    };
  }

  async call(publicName: string, args: Readonly<Record<string, unknown>>): Promise<JsonObject> {
    const mapping = this.toolByPublicName.get(publicName);
    if (!mapping) {
      return {
        content: [{ type: "text", text: `Unknown Morrow tool ${publicName}.` }],
        isError: true,
        structuredContent: {
          schema: "morrow.problem.v1",
          code: "tool_not_found",
        },
      };
    }

    const upstream = this.upstreams.get(mapping.upstreamId);
    if (!upstream) {
      return {
        content: [{ type: "text", text: `The source for ${publicName} is unavailable.` }],
        isError: true,
        structuredContent: {
          schema: "morrow.problem.v1",
          code: "upstream_unavailable",
          source: mapping.upstreamId,
        },
      };
    }

    const context = { mapping, catalogDigest: this.catalog.digest };
    try {
      const result = await upstream.callTool(mapping.upstreamName, args);
      return normalizeUpstreamResult(result, context);
    } catch (error) {
      return safeUpstreamFailure(error, context);
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.upstreams.values()].map((upstream) => upstream.close()));
  }
}
