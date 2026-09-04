import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  isJsonObject,
  sha256Json,
  sha256Text,
  type CatalogSnapshot,
  type CatalogSource,
  type CatalogTool,
  type GatewayCallMeta,
  type GatewayHealth,
  type JsonObject,
  type PublicationPolicyHealth,
  type RuntimeProfile,
  type SourceAttestationHealth,
  type ToolAnnotations,
} from "@morrow/contracts";
import {
  applyPublicationPolicy,
  ArtifactGenerationRegistry,
  LearnerVault,
  mergeCatalog,
  normalizeUpstreamResult,
  resolveLearnerTokens,
  safeUpstreamFailure,
} from "@morrow/gateway-core";
import {
  GatewayOperationConflictError,
  GatewayOperationJournal,
  classifySourceResult,
  operationRecordProjection,
  type GatewayOperationRecord,
  type GatewayOperationState,
} from "@morrow/operation-journal";
import { StdioMcpUpstream } from "@morrow/upstream-mcp";
import type { GatewayConfig } from "./config.js";
import { verifyLocalGitSourceAttestation } from "./source-attestation.js";

export const MORROW_NATIVE_TOOL_NAMES = Object.freeze([
  "morrow_health",
  "morrow_catalog",
  "morrow_catalog_search",
  "morrow_capability_get",
  "morrow_profile_status",
  "morrow_operation_get",
  "morrow_operations_recent",
] as const);

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

export interface RecentOperationsInput {
  readonly source?: string;
  readonly tool?: string;
  readonly state?: GatewayOperationState;
  readonly limit?: number;
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

function legacyRouting(args: Readonly<Record<string, unknown>>): {
  readonly suppliedOperationId?: string;
  readonly sourceBindingId?: string;
} {
  if (!isJsonObject(args._morrow)) return {};
  const suppliedOperationId = typeof args._morrow.operation_id === "string"
    ? args._morrow.operation_id.trim()
    : "";
  const sourceBindingId = typeof args._morrow.source_binding_id === "string"
    ? args._morrow.source_binding_id.trim()
    : "";
  return {
    ...(suppliedOperationId ? { suppliedOperationId } : {}),
    ...(sourceBindingId ? { sourceBindingId } : {}),
  };
}

function withSourceOperationId(
  mapping: CatalogTool,
  args: Readonly<Record<string, unknown>>,
): {
  readonly forwarded: Readonly<Record<string, unknown>>;
  readonly sourceOperationId?: string;
  readonly idempotencyKey?: string;
} {
  const forwarded = structuredClone(args) as Record<string, unknown>;
  if (mapping.upstreamId !== "example-legacy") {
    return { forwarded };
  }

  if (mapping.annotations?.readOnlyHint === true) {
    if (isJsonObject(forwarded._morrow)) {
      const routing = { ...forwarded._morrow };
      delete routing.operation_id;
      if (Object.keys(routing).length > 0) forwarded._morrow = routing;
      else delete forwarded._morrow;
    }
    return { forwarded };
  }

  const routing = legacyRouting(args);
  const sourceOperationId = routing.suppliedOperationId || `operation:${randomUUID()}`;
  forwarded._morrow = {
    ...(isJsonObject(forwarded._morrow) ? forwarded._morrow : {}),
    operation_id: sourceOperationId,
  };
  return {
    forwarded,
    sourceOperationId,
    ...(routing.suppliedOperationId ? { idempotencyKey: routing.suppliedOperationId } : {}),
  };
}

function attachOperationMeta(
  result: JsonObject,
  mapping: CatalogTool,
  catalogDigest: string,
  operation: GatewayOperationRecord,
  profile: RuntimeProfile,
): JsonObject {
  const output = structuredClone(result);
  const existingMeta = isJsonObject(output._meta) ? output._meta : {};
  const existingGatewayValue = existingMeta["io.morrow/gateway"];
  const upstreamResultSha256 = isJsonObject(existingGatewayValue)
    && typeof existingGatewayValue.upstreamResultSha256 === "string"
    ? existingGatewayValue.upstreamResultSha256
    : null;
  output._meta = {
    ...existingMeta,
    "io.morrow/gateway": {
      schema: "morrow.gateway.call.v1",
      publicToolName: mapping.publicName,
      upstreamId: mapping.upstreamId,
      upstreamToolName: mapping.upstreamName,
      catalogDigest,
      upstreamResultSha256: upstreamResultSha256
        || operation.upstreamResultDigest
        || operation.errorDigest
        || sha256Json(result),
      gatewayOperationId: operation.operationId,
      gatewayOperationState: operation.state,
      ...(operation.sourceOperationId ? { sourceOperationId: operation.sourceOperationId } : {}),
      ...(operation.sourceResultState ? { sourceResultState: operation.sourceResultState } : {}),
      ...(operation.sourceTaskId ? { sourceTaskId: operation.sourceTaskId } : {}),
      profile,
      authorityDigest: sha256Json({
        profile,
        publicToolName: mapping.publicName,
        upstreamId: mapping.upstreamId,
        upstreamToolName: mapping.upstreamName,
        catalogDigest,
      }),
    } satisfies GatewayCallMeta,
  };
  return output;
}

function replayResult(
  mapping: CatalogTool,
  catalogDigest: string,
  operation: GatewayOperationRecord,
  profile: RuntimeProfile,
): JsonObject {
  return attachOperationMeta({
    content: [{
      type: "text",
      text: `Morrow did not resend ${mapping.publicName}; the supplied operation identity already has a gateway record.`,
    }],
    isError: true,
    structuredContent: {
      schema: "morrow.problem.v1",
      code: "operation_already_recorded",
      recoverable: operation.state === "failed_before_send",
      operation: operationRecordProjection(operation),
    },
  }, mapping, catalogDigest, operation, profile);
}

function verifyConfiguredSources(
  config: GatewayConfig,
): ReadonlyMap<string, SourceAttestationHealth> {
  const evidence = new Map<string, SourceAttestationHealth>();
  for (const source of config.upstreams) {
    if (!source.attestation) continue;
    const verified = verifyLocalGitSourceAttestation(
      source.id,
      source.repository,
      source.attestation,
    );
    evidence.set(source.id, verified);
  }
  return evidence;
}

function readPublicationManifest(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Morrow could not read publication policy ${path}`, { cause: error });
  }
}

function applyProfileAvailability(catalog: CatalogSnapshot, profile: RuntimeProfile): CatalogSnapshot {
  const unavailable = catalog.tools
    .filter((tool) => tool.capability?.profiles[profile]?.state !== "supported")
    .map((tool) => ({
      upstreamId: tool.upstreamId,
      upstreamName: tool.upstreamName,
      reason: "profile_unavailable" as const,
      detail:
        tool.capability?.profiles[profile]?.reason ??
        `Unavailable in the ${profile} profile.`,
    }));
  if (unavailable.length === 0) return catalog;
  const tools = catalog.tools.filter((tool) => tool.capability?.profiles[profile]?.state === "supported");
  return {
    ...catalog,
    tools,
    excluded: [...catalog.excluded, ...unavailable].sort((left, right) => (
      compareAscii(left.upstreamId, right.upstreamId)
      || compareAscii(left.upstreamName, right.upstreamName)
      || compareAscii(left.reason, right.reason)
    )),
    countsBySource: Object.fromEntries(
      Object.keys(catalog.countsBySource).map((sourceId) => [
        sourceId,
        tools.filter((tool) => tool.upstreamId === sourceId).length,
      ]),
    ),
  };
}

async function closeStartupResources(
  upstreams: ReadonlyMap<string, StdioMcpUpstream>,
  journal: GatewayOperationJournal,
): Promise<void> {
  await Promise.allSettled([...upstreams.values()].map((candidate) => candidate.close()));
  journal.close();
}

export class GatewayRuntime {
  readonly config: GatewayConfig;
  readonly catalog: CatalogSnapshot;

  private readonly upstreams: ReadonlyMap<string, StdioMcpUpstream>;
  private readonly toolByPublicName: ReadonlyMap<string, CatalogTool>;
  private readonly journal: GatewayOperationJournal;
  private readonly publicationPolicy: PublicationPolicyHealth | undefined;
  private readonly learnerVault: LearnerVault;
  private readonly artifacts: ArtifactGenerationRegistry;

  private constructor(
    config: GatewayConfig,
    upstreams: ReadonlyMap<string, StdioMcpUpstream>,
    catalog: CatalogSnapshot,
    journal: GatewayOperationJournal,
    publicationPolicy?: PublicationPolicyHealth,
    learnerVault = new LearnerVault(":memory:"),
    artifacts = new ArtifactGenerationRegistry(),
  ) {
    this.config = config;
    this.upstreams = upstreams;
    this.catalog = catalog;
    this.journal = journal;
    this.publicationPolicy = publicationPolicy;
    this.learnerVault = learnerVault;
    this.artifacts = artifacts;
    this.toolByPublicName = new Map(catalog.tools.map((tool) => [tool.publicName, tool]));
  }

  static async connect(
    config: GatewayConfig,
    options: { readonly journalPath?: string } = {},
  ): Promise<GatewayRuntime> {
    const sourceAttestations = verifyConfiguredSources(config);
    const journal = new GatewayOperationJournal({
      path: options.journalPath || config.operationJournal.path,
    });
    const learnerVault = new LearnerVault(
      (options.journalPath || config.operationJournal.path) === ":memory:"
        ? ":memory:"
        : config.privacy.learnerVaultPath,
    );
    const upstreams = new Map<string, StdioMcpUpstream>();
    const sources: CatalogSource[] = [];

    for (const upstreamConfig of [...config.upstreams].sort((left, right) => (
      right.priority - left.priority || compareAscii(left.id, right.id)
    ))) {
      const attestation = sourceAttestations.get(upstreamConfig.id);
      const upstream = new StdioMcpUpstream({
        id: upstreamConfig.id,
        label: upstreamConfig.label,
        command: upstreamConfig.command,
        args: upstreamConfig.args,
        ...(upstreamConfig.cwd ? { cwd: upstreamConfig.cwd } : {}),
        env: upstreamConfig.env,
        priority: upstreamConfig.priority,
        required: upstreamConfig.required,
        ...(upstreamConfig.attestation?.expectedToolCount !== undefined
          ? { expectedToolCount: upstreamConfig.attestation.expectedToolCount }
          : {}),
        ...(upstreamConfig.attestation?.expectedCatalogDigest
          ? { expectedCatalogDigest: upstreamConfig.attestation.expectedCatalogDigest }
          : {}),
        ...(attestation ? { sourceAttestation: attestation } : {}),
      });
      upstreams.set(upstream.id, upstream);

      try {
        const tools = await upstream.connect();
        sources.push({
          id: upstream.id,
          label: upstream.label,
          priority: upstream.priority,
          ...(upstreamConfig.revision ? { revision: upstreamConfig.revision } : {}),
          tools,
        });
      } catch (error) {
        if (upstream.required) {
          await closeStartupResources(upstreams, journal);
          throw new Error(
            `Required upstream ${upstream.id} failed to connect`,
            { cause: error },
          );
        }
      }
    }

    try {
      const mergedCatalog = mergeCatalog(sources, {
        excludePrefixes: config.filters.excludePrefixes,
        excludeNames: config.filters.excludeNames,
        reservedNames: MORROW_NATIVE_TOOL_NAMES,
      });
      let catalog = mergedCatalog;
      let publicationPolicy: PublicationPolicyHealth | undefined;

      if (config.profile === "public-canvas") {
        const policyPath = config.publicationPolicy.path;
        if (!policyPath) throw new Error("public-canvas profile has no publication policy path");
        const sourceEvidence = [...upstreams.values()].map((upstream) => {
          const health = upstream.health();
          if (!health.connected || !health.catalogDigest) {
            throw new Error(`Publication source ${health.id} lacks a normalized catalog digest`);
          }
          return {
            sourceId: health.id,
            catalogDigest: health.catalogDigest,
            toolCount: health.toolCount,
          };
        });
        const applied = applyPublicationPolicy(
          mergedCatalog,
          readPublicationManifest(policyPath),
          sourceEvidence,
          {
            reservedNames: MORROW_NATIVE_TOOL_NAMES,
            deniedPrefixes: config.filters.excludePrefixes,
          },
        );
        catalog = applied.catalog;
        publicationPolicy = applied.receipt;
      }
      catalog = applyProfileAvailability(catalog, config.profile);

      if (catalog.tools.length > config.maxCatalogTools) {
        throw new Error(
          `Catalog contains ${catalog.tools.length} tools, above maxCatalogTools=${config.maxCatalogTools}`,
        );
      }

      return new GatewayRuntime(
        config,
        upstreams,
        catalog,
        journal,
        publicationPolicy,
        learnerVault,
      );
    } catch (error) {
      await closeStartupResources(upstreams, journal);
      throw error;
    }
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
      operationJournal: this.journal.health(),
      ...(this.publicationPolicy ? { publicationPolicy: this.publicationPolicy } : {}),
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

  capabilityGet(name: string): JsonObject {
    const capability = this.toolByPublicName.get(name.trim())?.capability;
    if (!capability) {
      return {
        schema: "morrow.problem.v1",
        code: "capability_not_found",
        profile: this.config.profile,
      };
    }
    return {
      schema: "morrow.capability-get.v1",
      profile: this.config.profile,
      descriptor: capability,
    };
  }

  profileStatus(): JsonObject {
    const profile = this.config.profile;
    const supported = this.catalog.tools.filter((tool) => tool.capability?.profiles[profile]?.state === "supported");
    const unavailable = this.catalog.excluded.filter((tool) => tool.reason === "profile_unavailable");
    return {
      schema: "morrow.profile-status.v1",
      profile,
      authorityDigest: sha256Json({
        profile,
        catalogDigest: this.catalog.digest,
        supported: supported.map((tool) => tool.publicName),
      }),
      supportedToolCount: supported.length,
      unavailableToolCount: unavailable.length,
      unavailable,
    };
  }

  operationGet(operationId: string): JsonObject {
    return operationRecordProjection(this.journal.get(operationId));
  }

  operationsRecent(input: RecentOperationsInput = {}): JsonObject {
    const operations = this.journal.list({
      ...(input.source ? { sourceId: input.source } : {}),
      ...(input.tool ? { publicToolName: input.tool } : {}),
      ...(input.state ? { state: input.state } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    }).map(operationRecordProjection);
    return {
      schema: "morrow.gateway-operations.list.v1",
      returned: operations.length,
      operations,
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

    const routed = withSourceOperationId(mapping, args);
    const requestDigest = sha256Json(args);
    const forwardedRequestDigest = sha256Json(routed.forwarded);
    let prepared;
    try {
      prepared = this.journal.prepare({
        publicToolName: mapping.publicName,
        sourceId: mapping.upstreamId,
        sourceToolName: mapping.upstreamName,
        catalogDigest: this.catalog.digest,
        requestDigest,
        forwardedRequestDigest,
        ...(routed.sourceOperationId ? { sourceOperationId: routed.sourceOperationId } : {}),
        ...(routed.idempotencyKey ? { idempotencyKey: routed.idempotencyKey } : {}),
        readOnly: mapping.annotations?.readOnlyHint === true,
      });
    } catch (error) {
      if (error instanceof GatewayOperationConflictError) {
        return {
          content: [{ type: "text", text: "The operation identity is already bound to a different exact request." }],
          isError: true,
          structuredContent: {
            schema: "morrow.problem.v1",
            code: error.code,
            recoverable: false,
            detailDigest: sha256Text(error.message),
          },
        };
      }
      throw error;
    }

    if (!prepared.created) {
      return replayResult(mapping, this.catalog.digest, prepared.record, this.config.profile);
    }

    const upstream = this.upstreams.get(mapping.upstreamId);
    if (!upstream) {
      const failed = this.journal.recordFailedBeforeSend(
        prepared.record.operationId,
        new Error("upstream unavailable"),
      );
      return attachOperationMeta({
        content: [{ type: "text", text: `The source for ${publicName} is unavailable.` }],
        isError: true,
        structuredContent: {
          schema: "morrow.problem.v1",
          code: "upstream_unavailable",
          source: mapping.upstreamId,
        },
      }, mapping, this.catalog.digest, failed, this.config.profile);
    }

    const course = typeof args.course_id === "string"
      ? args.course_id
      : typeof args.courseId === "string" ? args.courseId : "unbound";
    const descriptor = this.config.upstreams.find((upstreamConfig) => (
      upstreamConfig.id === mapping.upstreamId
    ))?.outputPrivacy[mapping.upstreamName];
    const privacy = {
      descriptor,
      learnerVault: this.learnerVault,
      learnerScope: {
        canvasOrigin: this.config.privacy.canvasOrigin,
        account: this.config.privacy.account,
        course,
        principal: this.config.privacy.principal,
        profile: this.config.profile,
      },
      artifacts: this.artifacts,
    };
    const baseContext = { mapping, catalogDigest: this.catalog.digest, privacy };
    let dispatchedArguments: Record<string, unknown>;
    try {
      dispatchedArguments = resolveLearnerTokens(routed.forwarded, this.learnerVault, privacy.learnerScope);
    } catch (error) {
      const failed = this.journal.recordFailedBeforeSend(prepared.record.operationId, error);
      return attachOperationMeta({
        content: [{ type: "text", text: "Morrow could not resolve the supplied learner token." }],
        isError: true,
        structuredContent: {
          schema: "morrow.problem.v1",
          code: "learner_token_unavailable",
          recoverable: false,
        },
      }, mapping, this.catalog.digest, failed, this.config.profile);
    }
    const dispatched = this.journal.markDispatched(prepared.record.operationId);
    try {
      const result = await upstream.callTool(mapping.upstreamName, dispatchedArguments);
      const normalized = normalizeUpstreamResult(result, baseContext);
      const source = classifySourceResult(result);
      const complete = this.journal.recordResponse(dispatched.operationId, {
        upstreamResultDigest: sha256Json(result),
        normalizedResultDigest: sha256Json(normalized),
        ...(source.state ? { sourceResultState: source.state } : {}),
        ...(source.taskId ? { sourceTaskId: source.taskId } : {}),
      });
      return attachOperationMeta(normalized, mapping, this.catalog.digest, complete, this.config.profile);
    } catch (error) {
      const unknown = this.journal.recordSourceUnknown(dispatched.operationId, error);
      return attachOperationMeta(
        safeUpstreamFailure(error, baseContext),
        mapping,
        this.catalog.digest,
        unknown,
        this.config.profile,
      );
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.upstreams.values()].map((upstream) => upstream.close()));
    this.journal.close();
  }

  recordGeneratedArtifact(bytes: Uint8Array): string {
    return this.artifacts.record(bytes);
  }
}
