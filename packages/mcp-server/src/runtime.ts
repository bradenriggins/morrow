import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  isJsonObject,
  sha256Json,
  sha256Text,
  upstreamCatalogDigest,
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
  canonicalMorrowResult,
  mergeCatalog,
  normalizeUpstreamResult,
  resolveLearnerTokens,
  safeUpstreamFailure,
} from "@morrow/gateway-core";
import {
  GatewayOperationConflictError,
  GatewayOperationJournal,
  ProviderEffectBroker,
  classifySourceResult,
  effectOperationProjection,
  operationRecordProjection,
  type EffectOperationRecord,
  type FrozenReadbackPlan,
  type GatewayOperationRecord,
  type GatewayOperationState,
} from "@morrow/operation-journal";
import { StdioMcpUpstream } from "@morrow/upstream-mcp";
import type { GatewayConfig } from "./config.js";
import { ResultArtifactStore } from "./result-artifacts.js";
import { loadExamplePlatformCatalogTruth } from "./meridian-catalog-truth.js";
import { buildExamplePlatformSshLaunch } from "./meridian-runtime-adapter.js";
import {
  verifyLocalGitSourceAttestation,
  verifyRemoteGitSshSourceAttestation,
} from "./source-attestation.js";

export const MORROW_NATIVE_TOOL_NAMES = Object.freeze([
  "morrow_health",
  "morrow_catalog",
  "morrow_catalog_search",
  "morrow_capability_get",
  "morrow_profile_status",
  "morrow_operation_get",
  "morrow_operations_recent",
  "morrow_operation_list",
  "morrow_operation_dispatch",
  "morrow_operation_cancel",
  "morrow_operation_reconcile",
  "morrow_operation_verify",
  "morrow_operation_undo",
  "morrow_operation_approve",
  "morrow_result_page",
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
    delete forwarded._morrow;
    return { forwarded };
  }

  if (mapping.annotations?.readOnlyHint === true) {
    if (isJsonObject(forwarded._morrow)) {
      const routing = { ...forwarded._morrow };
      delete routing.operation_id;
      delete routing.readback;
      delete routing.approval_ttl_ms;
      delete routing.outer_grant;
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

interface OuterOperationControls {
  readonly request: JsonObject;
  readonly readback?: FrozenReadbackPlan;
  readonly approvalTtlMs?: number;
}

function outerOperationControls(args: Readonly<Record<string, unknown>>): OuterOperationControls {
  const request = structuredClone(args) as JsonObject;
  if (!isJsonObject(request._morrow)) return { request };
  const routing = { ...request._morrow };
  const rawReadback = routing.readback;
  const rawTtl = routing.approval_ttl_ms;
  delete routing.readback;
  delete routing.approval_ttl_ms;
  delete routing.outer_grant;
  if (Object.keys(routing).length > 0) request._morrow = routing;
  else delete request._morrow;

  let readback: FrozenReadbackPlan | undefined;
  if (rawReadback !== undefined) {
    if (!isJsonObject(rawReadback) || typeof rawReadback.tool !== "string" || !isJsonObject(rawReadback.arguments)
      || typeof rawReadback.expected_digest !== "string" || !/^[0-9a-f]{64}$/.test(rawReadback.expected_digest)) {
      throw new TypeError("_morrow.readback requires tool, arguments, and expected_digest");
    }
    readback = {
      tool: rawReadback.tool,
      arguments: structuredClone(rawReadback.arguments),
      expectedDigest: rawReadback.expected_digest,
    };
  }
  const approvalTtlMs = rawTtl === undefined
    ? undefined
    : typeof rawTtl === "number" && Number.isInteger(rawTtl) && rawTtl >= 60_000 && rawTtl <= 24 * 60 * 60_000
      ? rawTtl
      : (() => { throw new TypeError("_morrow.approval_ttl_ms must be 60000 through 86400000"); })();
  return { request, ...(readback ? { readback } : {}), ...(approvalTtlMs ? { approvalTtlMs } : {}) };
}

function resultComparable(value: JsonObject): JsonObject {
  if (isJsonObject(value.structuredContent)) return structuredClone(value.structuredContent);
  return {
    content: Array.isArray(value.content) ? structuredClone(value.content) : [],
    isError: value.isError === true,
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
    const verified = source.attestation.kind === "remote-git-ssh"
      ? verifyRemoteGitSshSourceAttestation(
          source.id,
          source.repository,
          source.attestation,
        )
      : verifyLocalGitSourceAttestation(
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
  effects: ProviderEffectBroker,
): Promise<void> {
  await Promise.allSettled([...upstreams.values()].map((candidate) => candidate.close()));
  journal.close();
  effects.close();
}

export class GatewayRuntime {
  readonly config: GatewayConfig;
  readonly catalog: CatalogSnapshot;

  private readonly upstreams: ReadonlyMap<string, StdioMcpUpstream>;
  private readonly toolByPublicName: ReadonlyMap<string, CatalogTool>;
  private readonly journal: GatewayOperationJournal;
  private readonly effects: ProviderEffectBroker;
  private readonly resultArtifacts = new ResultArtifactStore();
  private readonly publicationPolicy: PublicationPolicyHealth | undefined;
  private readonly learnerVault: LearnerVault;
  private readonly artifacts: ArtifactGenerationRegistry;
  private approvalBaseUrl: string | null = null;
  private readonly gatewayProcessId = `gateway:${randomUUID()}`;

  private constructor(
    config: GatewayConfig,
    upstreams: ReadonlyMap<string, StdioMcpUpstream>,
    catalog: CatalogSnapshot,
    journal: GatewayOperationJournal,
    effects: ProviderEffectBroker,
    publicationPolicy?: PublicationPolicyHealth,
    learnerVault = new LearnerVault(":memory:"),
    artifacts = new ArtifactGenerationRegistry(),
  ) {
    this.config = config;
    this.upstreams = upstreams;
    this.catalog = catalog;
    this.journal = journal;
    this.effects = effects;
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
    const catalogTruth = new Map<string, ReturnType<typeof loadExamplePlatformCatalogTruth>>(config.upstreams
      .filter((source) => source.kind === "meridian-ssh")
      .map((source) => [
        source.id,
        loadExamplePlatformCatalogTruth(source, config.filters),
      ]));
    const journal = new GatewayOperationJournal({
      path: options.journalPath || config.operationJournal.path,
    });
    const learnerVault = new LearnerVault(
      (options.journalPath || config.operationJournal.path) === ":memory:"
        ? ":memory:"
        : config.privacy.learnerVaultPath,
    );
    const effects = new ProviderEffectBroker({
      path: options.journalPath || config.operationJournal.path,
    });
    const upstreams = new Map<string, StdioMcpUpstream>();
    const sources: CatalogSource[] = [];

    for (const upstreamConfig of [...config.upstreams].sort((left, right) => (
      right.priority - left.priority || compareAscii(left.id, right.id)
    ))) {
      const attestation = sourceAttestations.get(upstreamConfig.id);
      const truth = catalogTruth.get(upstreamConfig.id);
      const launch = upstreamConfig.kind === "meridian-ssh"
        ? buildExamplePlatformSshLaunch({
            host: upstreamConfig.host,
            remoteRoot: upstreamConfig.remoteRoot,
            serverPath: upstreamConfig.serverPath,
            runtimeProfile: upstreamConfig.runtimeProfile,
          })
        : {
            command: upstreamConfig.command,
            args: upstreamConfig.args,
            ...(upstreamConfig.cwd ? { cwd: upstreamConfig.cwd } : {}),
            env: upstreamConfig.env,
          };
      const upstream = new StdioMcpUpstream({
        id: upstreamConfig.id,
        label: upstreamConfig.label,
        command: launch.command,
        args: launch.args,
        ...(upstreamConfig.kind === "mcp-stdio" && upstreamConfig.cwd
          ? { cwd: upstreamConfig.cwd }
          : {}),
        ...(upstreamConfig.kind === "mcp-stdio" ? { env: upstreamConfig.env } : {}),
        ...(upstreamConfig.kind === "meridian-ssh" ? { stderr: "ignore" as const } : {}),
        priority: upstreamConfig.priority,
        required: upstreamConfig.required,
        ...(truth
          ? { expectedToolCount: truth.health.totalToolCount }
          : upstreamConfig.attestation?.kind === "local-git"
            && upstreamConfig.attestation.expectedToolCount !== undefined
          ? { expectedToolCount: upstreamConfig.attestation.expectedToolCount }
          : {}),
        ...(truth
          ? { expectedCatalogDigest: truth.health.upstreamCatalogDigest }
          : upstreamConfig.attestation?.kind === "local-git"
            && upstreamConfig.attestation.expectedCatalogDigest
          ? { expectedCatalogDigest: upstreamConfig.attestation.expectedCatalogDigest }
          : {}),
        ...(attestation ? { sourceAttestation: attestation } : {}),
        ...(truth ? { catalogTruth: truth.health } : {}),
        ...(upstreamConfig.kind === "meridian-ssh"
          ? {
              supervision: upstreamConfig.supervision,
              beforeConnect: () => {
                verifyRemoteGitSshSourceAttestation(
                  upstreamConfig.id,
                  upstreamConfig.repository,
                  upstreamConfig.attestation,
                );
              },
            }
          : {}),
      });
      upstreams.set(upstream.id, upstream);

      try {
        const tools = await upstream.connect();
        if (truth) {
          const excludedNames = new Set(config.filters.excludeNames);
          const eligibleTools = tools.filter((tool) => (
            !excludedNames.has(tool.name)
            && !config.filters.excludePrefixes.some((prefix) => tool.name.startsWith(prefix))
          ));
          if (
            eligibleTools.length !== truth.health.eligibleToolCount
            || upstreamCatalogDigest(upstream.id, eligibleTools) !== truth.health.eligibleCatalogDigest
          ) {
            throw new Error(`Source ${upstream.id} eligible catalog does not match generated truth.`);
          }
        }
        sources.push({
          id: upstream.id,
          label: upstream.label,
          priority: upstream.priority,
          ...(upstreamConfig.revision ? { revision: upstreamConfig.revision } : {}),
          tools,
        });
      } catch (error) {
        if (upstream.required) {
          await closeStartupResources(upstreams, journal, effects);
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
      for (const [sourceId, truth] of catalogTruth) {
        if ((mergedCatalog.countsBySource[sourceId] ?? 0) !== truth.health.eligibleToolCount) {
          throw new Error(`Source ${sourceId} eligible catalog does not match generated truth.`);
        }
      }
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
        effects,
        publicationPolicy,
        learnerVault,
      );
    } catch (error) {
      await closeStartupResources(upstreams, journal, effects);
      throw error;
    }
  }

  health(): GatewayHealth {
    const sources = [...this.upstreams.values()].map((upstream) => upstream.health());
    return {
      schema: "morrow.health.v1",
      version: "1.0.0-rc.0",
      ready: sources.every((source) => (
        !source.required
        || (
          source.connected
          && source.catalogAttested !== false
        )
      )),
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

  effectHealth(): JsonObject {
    const recent = this.effects.list(200);
    const unresolved = recent.filter((operation) => !["verified", "failed", "cancelled"].includes(operation.state));
    return {
      schema: "morrow.effect-broker.health.v1",
      open: true,
      recentOperationCount: recent.length,
      recentCoverageComplete: recent.length < 200,
      unresolvedOperationCount: unresolved.length,
      appliedOrUnknownCount: recent.filter((operation) => operation.state === "applied_or_unknown").length,
      dispatchingCount: recent.filter((operation) => operation.state === "dispatching").length,
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
    if (operationId.startsWith("op:")) {
      return effectOperationProjection(this.effects.get(operationId));
    }
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

  operationList(limit = 50): JsonObject {
    const operations = this.effects.list(limit).map(effectOperationProjection);
    return {
      schema: "morrow.operations.list.v1",
      returned: operations.length,
      operations,
    };
  }

  approvalUrl(operationId: string): string | null {
    return this.approvalBaseUrl ? `${this.approvalBaseUrl}/operations/${encodeURIComponent(operationId)}` : null;
  }

  setApprovalBaseUrl(baseUrl: string): void {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
      throw new TypeError("approval service must use the loopback address");
    }
    this.approvalBaseUrl = parsed.origin;
  }

  approveOperation(operationId: string): JsonObject {
    return effectOperationProjection(this.effects.approve(operationId));
  }

  cancelOperation(operationId: string): JsonObject {
    return effectOperationProjection(this.effects.cancel(operationId));
  }

  private effectResult(record: EffectOperationRecord, phase: string, result?: JsonObject): JsonObject {
    const verificationStatus = record.verificationStatus === "verified"
      ? "verified"
      : record.readback ? "unconfirmed" : "not_requested";
    return canonicalMorrowResult({
      ...(result ? { result } : {}),
      operationId: record.operationId,
      tool: record.publicToolName,
      phase,
      effectState: record.state,
      verificationStatus,
      attention: record.attention,
      limitations: record.state === "awaiting_inner_approval"
        ? ["The source still requires its own human approval. Morrow did not infer provider completion."]
        : record.state === "awaiting_verification"
          ? ["A fresh, frozen readback comparator is required before Morrow can report verified."]
          : record.state === "applied_or_unknown"
            ? ["Morrow will not replay this operation because the provider effect may have occurred."]
            : undefined,
      receipts: {
        planDigest: record.planDigest,
        ...(record.approvalGrantDigest ? { approvalGrantDigest: record.approvalGrantDigest } : {}),
        ...(record.effectReceiptId ? { effectReceiptId: record.effectReceiptId } : {}),
        dispatchAttempt: record.dispatchAttempt,
        ...(record.readbackDigest ? { readbackDigest: record.readbackDigest } : {}),
        ...(this.approvalUrl(record.operationId) && record.state === "awaiting_approval"
          ? { approvalUrl: this.approvalUrl(record.operationId) }
          : {}),
      },
    });
  }

  private planEffect(
    mapping: CatalogTool,
    controls: OuterOperationControls,
    correctionOf?: string,
  ): EffectOperationRecord {
    const routed = withSourceOperationId(mapping, controls.request);
    const routing = legacyRouting(controls.request);
    return this.effects.create({
      publicToolName: mapping.publicName,
      sourceId: mapping.upstreamId,
      sourceToolName: mapping.upstreamName,
      catalogDigest: this.catalog.digest,
      request: controls.request,
      forwardedRequest: routed.forwarded as JsonObject,
      ...(routed.sourceOperationId ? { sourceOperationId: routed.sourceOperationId } : {}),
      ...(routing.sourceBindingId ? { sourceBindingId: routing.sourceBindingId } : {}),
      ...(controls.readback ? { readback: controls.readback } : {}),
      ...(controls.approvalTtlMs ? { approvalTtlMs: controls.approvalTtlMs } : {}),
      ...(correctionOf ? { correctionOf } : {}),
    });
  }

  resultPage(handle: string, offset?: number, limit?: number): JsonObject {
    return this.resultArtifacts.page(handle, offset, limit) as unknown as JsonObject;
  }

  async call(
    publicName: string,
    args: Readonly<Record<string, unknown>>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const mapping = this.toolByPublicName.get(publicName);
    if (!mapping) {
      return canonicalMorrowResult({
        tool: publicName,
        phase: "rejected",
        verificationStatus: "not_applicable",
        result: {
        content: [{ type: "text", text: `Unknown Morrow tool ${publicName}.` }],
        isError: true,
        structuredContent: {
          schema: "morrow.problem.v1",
          code: "tool_not_found",
        },
        },
      });
    }
    if (mapping.annotations?.readOnlyHint === true) {
      const result = await this.callSourceOwned(publicName, args, options);
      return canonicalMorrowResult({
        result,
        tool: publicName,
        phase: "read",
        verificationStatus: "not_applicable",
      });
    }
    try {
      const operation = this.planEffect(mapping, outerOperationControls(args));
      return this.effectResult(operation, "planned");
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
      return canonicalMorrowResult({
        tool: publicName,
        phase: "rejected",
        verificationStatus: "not_requested",
        result: {
          content: [{ type: "text", text: "Morrow could not freeze this operation plan." }],
          isError: true,
          structuredContent: {
            schema: "morrow.problem.v1",
            code: "operation_plan_invalid",
            detailDigest: sha256Text(detail),
          },
        },
      });
    }
  }

  async dispatchOperation(operationId: string): Promise<JsonObject> {
    let reserved: EffectOperationRecord;
    try {
      reserved = this.effects.reserveDispatch(operationId);
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
      return canonicalMorrowResult({
        operationId,
        tool: "morrow_operation_dispatch",
        phase: "rejected",
        verificationStatus: "not_requested",
        result: {
          content: [{ type: "text", text: "Morrow did not dispatch this operation." }],
          isError: true,
          structuredContent: { schema: "morrow.problem.v1", code: "operation_dispatch_refused", detailDigest: sha256Text(detail) },
        },
      });
    }
    if (reserved.state !== "dispatching") return this.effectResult(reserved, "dispatch_refused");
    const mapping = this.toolByPublicName.get(reserved.publicToolName);
    if (!mapping) {
      const settled = this.effects.settleFailure(reserved.operationId, "frozen_tool_mapping_missing", false);
      return this.effectResult(settled, "dispatch_failed");
    }
    const forwarded = structuredClone(reserved.forwardedRequest) as Record<string, unknown>;
    if (mapping.upstreamId === "example-legacy") {
      forwarded._morrow = {
        ...(isJsonObject(forwarded._morrow) ? forwarded._morrow : {}),
        operation_id: reserved.sourceOperationId || reserved.operationId,
        outer_grant: {
          plan_digest: reserved.planDigest,
          approval_grant_digest: reserved.approvalGrantDigest,
          effect_receipt_id: reserved.effectReceiptId,
          dispatch_attempt: reserved.dispatchAttempt,
          gateway_process_id: this.gatewayProcessId,
        },
      };
    }
    const result = await this.callSourceOwned(mapping.publicName, forwarded);
    const source = classifySourceResult(result);
    if (result.isError === true) {
      const meta = isJsonObject(result._meta) && isJsonObject(result._meta["io.morrow/gateway"])
        ? result._meta["io.morrow/gateway"] : {};
      const definitelyNotSent = meta.gatewayOperationState === "failed_before_send" || source.state === "not_sent";
      const settled = this.effects.settleFailure(reserved.operationId, result, !definitelyNotSent);
      return this.effectResult(settled, "dispatch_failed", result);
    }
    const innerApprovalRequired = /awaiting.*approval|pending.*approval|staged/i.test(source.state || "")
      || (mapping.upstreamId === "example-legacy" && Boolean(source.taskId));
    const settled = this.effects.settleResponse(reserved.operationId, {
      upstreamResultDigest: sha256Json(result),
      ...(source.state ? { sourceResultState: source.state } : {}),
      ...(source.taskId ? { sourceTaskId: source.taskId } : {}),
      innerApprovalRequired,
    });
    return this.effectResult(settled, "dispatched", result);
  }

  async verifyOperation(operationId: string): Promise<JsonObject> {
    const operation = this.effects.get(operationId);
    if (!operation.readback) {
      return this.effectResult(operation, "verification_unsupported");
    }
    if (operation.state === "awaiting_inner_approval") {
      return this.effectResult(operation, "verification_requires_inner_approval");
    }
    const mapping = this.toolByPublicName.get(operation.readback.tool);
    if (!mapping || mapping.annotations?.readOnlyHint !== true) {
      return this.effectResult(operation, "verification_unsupported");
    }
    const fresh = await this.callSourceOwned(mapping.publicName, operation.readback.arguments);
    if (fresh.isError === true) return this.effectResult(operation, "verification_failed", fresh);
    const readbackDigest = sha256Json(resultComparable(fresh));
    const settled = this.effects.recordReadback(
      operation.operationId,
      readbackDigest,
      readbackDigest === operation.readback.expectedDigest,
    );
    return this.effectResult(settled, "verified_readback", fresh);
  }

  reconcileOperation(operationId: string): JsonObject {
    const operation = this.effects.get(operationId);
    return this.effectResult(operation, "reconciliation_requires_provider_evidence");
  }

  undoOperation(
    operationId: string,
    correctionTool: string,
    correctionArguments: Readonly<Record<string, unknown>>,
  ): JsonObject {
    const original = this.effects.get(operationId);
    const mapping = this.toolByPublicName.get(correctionTool);
    if (!mapping || mapping.annotations?.readOnlyHint === true) {
      throw new Error("A correction must use one current mutating Morrow tool");
    }
    const correction = this.planEffect(mapping, outerOperationControls(correctionArguments), original.operationId);
    return this.effectResult(correction, "correction_planned");
  }

  async callSourceOwned(
    publicName: string,
    args: Readonly<Record<string, unknown>>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const mapping = this.toolByPublicName.get(publicName);
    if (!mapping) {
      return {
        content: [{ type: "text", text: `Unknown Morrow tool ${publicName}.` }],
        isError: true,
        structuredContent: { schema: "morrow.problem.v1", code: "tool_not_found" },
      };
    }

    if (options.signal?.aborted) {
      return {
        content: [{ type: "text", text: `Morrow cancelled ${publicName} before source dispatch.` }],
        isError: true,
        structuredContent: {
          schema: "morrow.problem.v1",
          code: "request_cancelled_before_dispatch",
          recoverable: true,
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

    if (options.signal?.aborted) {
      const cancelled = this.journal.recordFailedBeforeSend(
        prepared.record.operationId,
        new Error("request cancelled before source dispatch"),
      );
      return attachOperationMeta({
        content: [{ type: "text", text: `Morrow cancelled ${publicName} before source dispatch.` }],
        isError: true,
        structuredContent: {
          schema: "morrow.problem.v1",
          code: "request_cancelled_before_dispatch",
          recoverable: true,
        },
      }, mapping, this.catalog.digest, cancelled, this.config.profile);
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
      const result = await upstream.callTool(mapping.upstreamName, dispatchedArguments, {
        signal: options.signal,
        safeToRetry: mapping.upstreamId === "meridian"
          && mapping.annotations?.readOnlyHint === true,
      });
      const normalized = normalizeUpstreamResult(result, baseContext);
      const source = classifySourceResult(result);
      const complete = this.journal.recordResponse(dispatched.operationId, {
        upstreamResultDigest: sha256Json(result),
        normalizedResultDigest: sha256Json(normalized),
        ...(source.state ? { sourceResultState: source.state } : {}),
        ...(source.taskId ? { sourceTaskId: source.taskId } : {}),
      });
      return this.resultArtifacts.bound(
        attachOperationMeta(normalized, mapping, this.catalog.digest, complete, this.config.profile),
      );
    } catch (error) {
      const unknown = this.journal.recordSourceUnknown(dispatched.operationId, error);
      const failure = safeUpstreamFailure(error, baseContext);
      if (options.signal?.aborted) {
        failure.structuredContent = {
          schema: "morrow.problem.v1",
          code: "request_cancelled_after_dispatch",
          recoverable: false,
          source: mapping.upstreamId,
          detailDigest: sha256Text(error instanceof Error ? `${error.name}:${error.message}` : String(error)),
        };
      }
      return this.resultArtifacts.bound(
        attachOperationMeta(failure, mapping, this.catalog.digest, unknown, this.config.profile),
      );
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.upstreams.values()].map((upstream) => upstream.close()));
    this.journal.close();
    this.effects.close();
  }

  recordGeneratedArtifact(bytes: Uint8Array): string {
    return this.artifacts.record(bytes);
  }
}
