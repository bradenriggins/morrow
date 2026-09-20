import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod/v4";
import { normalizeSourceId, type GatewayRuntimeLimitation } from "@morrow/contracts";
import { SOURCE_DISPOSITIONS } from "@morrow/gateway-core";
import { readExactTrustJson } from "./exact-trust-file.js";

export const MAX_GATEWAY_CONFIG_BYTES = 4 * 1024 * 1024;

const EnvironmentName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const EnvironmentTemplateValue = /\$\{[A-Z_][A-Z0-9_]*(?::-[^}]*)?\}/;
const FullGitRevision = z.string().min(1).max(500).refine((value) => (
  /^[0-9a-fA-F]{40,64}$/.test(value) || EnvironmentTemplateValue.test(value)
), "expected a full Git revision or environment template");
const Sha256Digest = z.string().min(1).max(500).refine((value) => (
  /^[0-9a-fA-F]{64}$/.test(value) || EnvironmentTemplateValue.test(value)
), "expected a SHA-256 digest or environment template");
const RepositoryRelativePath = z.string().min(1).max(500);
const SafeRepositoryRelativePath = RepositoryRelativePath.refine((value) => (
  !value.startsWith("/")
  && !/^[A-Za-z]:[\\/]/.test(value)
  && !/[\0\r\n]/.test(value)
  && !value.replaceAll("\\", "/").split("/").some((segment) => !segment || segment === "." || segment === "..")
), "expected a safe repository-relative path");
const RuntimeIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const CanvasId = z.string().regex(/^[1-9][0-9]{0,18}$/);
const SshHost = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/);
const RemoteAbsolutePath = z.string().min(1).max(500).refine((value) => (
  value.startsWith("/") && !/[\0\r\n]/.test(value) && !value.split("/").includes("..")
), "expected a safe absolute remote path");
const RemoteRelativePath = z.string().min(1).max(300).refine((value) => (
  !value.startsWith("/")
  && !/[\0\r\n]/.test(value)
  && !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
), "expected a safe repository-relative remote path");

const OutputPrivacyDescriptorSchema = z.object({
  allowedFields: z.array(z.string().min(1).max(160)).max(100).default([]),
  fieldPolicy: z.enum(["allow-listed", "scrub-sensitive"]).default("allow-listed"),
  dataClass: z.enum(["public", "course", "learner"]).default("public"),
  maxRecords: z.number().int().min(0).max(10_000).default(0),
  maxBytes: z.number().int().min(0).max(10_000_000).default(0),
  freeText: z.enum(["allow", "deny"]).default("deny"),
  learnerTokens: z.boolean().default(false),
  artifactInspection: z.enum(["deny", "text", "trusted-generated"]).default("deny"),
  aiClientAdmission: z.enum(["allow", "deny"]).default("allow"),
});

const LocalGitAttestationSchema = z.object({
  kind: z.literal("local-git"),
  root: z.string().min(1),
  expectedRevision: FullGitRevision,
  requireTrackedClean: z.boolean().default(true),
  allowedTrackedPaths: z.array(RepositoryRelativePath).max(20).default([]),
  expectedTrackedPatchDigest: Sha256Digest.optional(),
  expectedToolCount: z.number().int().min(1).max(5000).optional(),
  expectedCatalogDigest: Sha256Digest.optional(),
  launch: z.object({
    entrypoint: SafeRepositoryRelativePath,
    entrypointArgumentIndex: z.number().int().min(0).max(100).default(0),
    expectedEntrypointSha256: Sha256Digest.optional(),
    runtime: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("current-node") }),
      z.object({
        kind: z.literal("sha256"),
        expectedExecutableSha256: Sha256Digest,
      }),
    ]).default({ kind: "current-node" }),
  }),
});

const RemoteGitSshAttestationSchema = z.object({
  kind: z.literal("remote-git-ssh"),
  host: SshHost,
  root: RemoteAbsolutePath,
  expectedRevision: FullGitRevision,
  requireTrackedClean: z.literal(true).default(true),
});

const SupervisionSchema = z.object({
  startupAttempts: z.number().int().min(1).max(8).default(3),
  reconnectAttempts: z.number().int().min(1).max(8).default(3),
  initialBackoffMs: z.number().int().min(1).max(30_000).default(100),
  maxBackoffMs: z.number().int().min(1).max(60_000).default(2_000),
}).refine(
  (value) => value.maxBackoffMs >= value.initialBackoffMs,
  "maxBackoffMs must be greater than or equal to initialBackoffMs",
);

const CatalogTruthSchema = z.object({
  path: z.string().min(1),
  fileSha256: Sha256Digest,
});

const CanvasConnectionSchema = z.object({
  kind: z.enum(["session-path", "credential-path", "socket"]),
  path: RemoteAbsolutePath,
});

const CatalogRuntimeProfileSchema = z.object({
  kind: z.literal("catalog-hermetic"),
  profileId: RuntimeIdentifier.default("morrow-catalog"),
  environment: z.literal("test").default("test"),
  localOperator: RuntimeIdentifier.default("morrow-catalog"),
  sessionId: RuntimeIdentifier.default("catalog-list"),
  stateDirectory: RemoteAbsolutePath,
  mode: z.literal("read-only").default("read-only"),
});

const PrivateRuntimeProfileSchema = z.object({
  kind: z.literal("private-runtime"),
  profileId: RuntimeIdentifier,
  environment: z.enum(["test", "staging", "production"]),
  localOperator: RuntimeIdentifier,
  sessionId: RuntimeIdentifier,
  stateDirectory: RemoteAbsolutePath,
  mode: z.enum(["read-only", "plan", "edit"]).default("read-only"),
  canvasConnection: CanvasConnectionSchema.optional(),
  courseScope: z.object({ courseId: CanvasId }).optional(),
  operation: z.object({
    id: RuntimeIdentifier,
    taskContractDigest: Sha256Digest,
  }).optional(),
  learnerVault: z.object({
    vaultId: z.string().regex(/^c_[0-9a-f]{16}$/),
  }).optional(),
}).superRefine((value, context) => {
  if (value.learnerVault && !value.operation) {
    context.addIssue({
      code: "custom",
      message: "learnerVault requires an exact operation binding",
      path: ["learnerVault"],
    });
  }
});

const StdioUpstreamSchema = z.object({
  id: z.string().min(1).transform((value) => normalizeSourceId(value)),
  label: z.string().min(1),
  kind: z.literal("mcp-stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  env: z.record(EnvironmentName, z.string()).default({}),
  repository: z.string().min(1).max(300).optional(),
  revision: z.string().min(1).max(300).optional(),
  sourceDisposition: z.enum(SOURCE_DISPOSITIONS).default("private_runtime_dependency"),
  attestation: LocalGitAttestationSchema.optional(),
  outputPrivacy: z.record(z.string().min(1).max(160), OutputPrivacyDescriptorSchema).default({}),
  outputPrivacyDefault: OutputPrivacyDescriptorSchema.optional(),
  priority: z.number().int().default(0),
  required: z.boolean().default(true),
  enabled: z.boolean().default(true),
});

const ExamplePlatformSshUpstreamSchema = z.object({
  id: z.literal("meridian"),
  label: z.string().min(1),
  kind: z.literal("meridian-ssh"),
  host: SshHost,
  remoteRoot: RemoteAbsolutePath,
  serverPath: RemoteRelativePath.default("scripts/team/mcp/meridian_server.py"),
  repository: z.string().min(1).max(300).optional(),
  revision: FullGitRevision,
  sourceDisposition: z.enum(SOURCE_DISPOSITIONS).default("private_runtime_dependency"),
  attestation: RemoteGitSshAttestationSchema,
  catalogTruth: CatalogTruthSchema,
  runtimeProfile: z.discriminatedUnion("kind", [
    CatalogRuntimeProfileSchema,
    PrivateRuntimeProfileSchema,
  ]),
  supervision: SupervisionSchema.default({
    startupAttempts: 3,
    reconnectAttempts: 3,
    initialBackoffMs: 100,
    maxBackoffMs: 2_000,
  }),
  priority: z.number().int().default(100),
  required: z.boolean().default(true),
  enabled: z.boolean().default(true),
  outputPrivacy: z.record(z.string().min(1).max(160), OutputPrivacyDescriptorSchema).default({}),
  outputPrivacyDefault: OutputPrivacyDescriptorSchema.optional(),
});

const UpstreamSchema = z.discriminatedUnion("kind", [
  StdioUpstreamSchema,
  ExamplePlatformSshUpstreamSchema,
]);

const GatewayConfigSchema = z.object({
  schema: z.literal("morrow.upstreams.v1"),
  profile: z.enum(["private-full", "public-canvas", "sandbox", "read-only"]).default("private-full"),
  toolSurface: z.enum(["compact", "full"]).default("compact"),
  upstreams: z.array(UpstreamSchema).min(1),
  sourcePolicy: z.object({
    requireAttestation: z.boolean().default(false),
  }).default({ requireAttestation: false }),
  publicationPolicy: z.object({
    path: z.string().min(1).optional(),
    requiredForPublicProfile: z.boolean().default(true),
  }).default({ requiredForPublicProfile: true }),
  filters: z.object({
    excludePrefixes: z.array(z.string()).default(["mindtap_", "connect_"]),
    excludeNames: z.array(z.string()).default([]),
  }).default({
    excludePrefixes: ["mindtap_", "connect_"],
    excludeNames: [],
  }),
  operationJournal: z.object({
    path: z.string().min(1).default(".morrow/morrow.sqlite3"),
  }).default({ path: ".morrow/morrow.sqlite3" }),
  batchScheduler: z.object({
    maxConcurrentReadWindows: z.number().int().min(1).max(8).default(2),
  }).default({ maxConcurrentReadWindows: 2 }),
  privacy: z.object({
    canvasOrigin: z.string().min(1).max(500).default("local"),
    account: z.string().min(1).max(500).default("local-account"),
    principal: z.string().min(1).max(500).default("local-principal"),
    learnerVaultPath: z.string().min(1).default(".morrow/learner-vault.json"),
  }).default({
    canvasOrigin: "local",
    account: "local-account",
    principal: "local-principal",
    learnerVaultPath: ".morrow/learner-vault.json",
  }),
  maxCatalogTools: z.number().int().positive().max(5000).default(2000),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema> & {
  readonly runtimeLimitations?: readonly GatewayRuntimeLimitation[];
};
export type UpstreamConfig = z.infer<typeof UpstreamSchema>;
export type StdioUpstreamConfig = Extract<UpstreamConfig, { kind: "mcp-stdio" }>;
export type ExamplePlatformSshUpstreamConfig = Extract<UpstreamConfig, { kind: "meridian-ssh" }>;
export type LocalGitAttestationConfig = z.infer<typeof LocalGitAttestationSchema>;
export type RemoteGitSshAttestationConfig = z.infer<typeof RemoteGitSshAttestationSchema>;

export function assertUniqueCanonicalUpstreamIds(
  upstreams: readonly Pick<UpstreamConfig, "id">[],
): void {
  const seen = new Set<string>();
  for (const upstream of upstreams) {
    const id = normalizeSourceId(upstream.id);
    if (seen.has(id)) throw new Error(`Duplicate canonical upstream id ${id}`);
    seen.add(id);
  }
}

const TEMPLATE = /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Every shipped launch runs the gateway with its working directory set to the
 * materials workspace, not to the installed payload, so the payload layout has
 * to be found from this module rather than from the working directory.
 */
function resolveBlackboardRuntimeEntry(workingDirectory: string): string | undefined {
  const packaged = resolve(dirname(fileURLToPath(import.meta.url)), "../../blackboard-learn-api/dist/index.js");
  if (existsSync(packaged)) return packaged;
  try {
    const installed = createRequire(import.meta.url).resolve("@morrow/blackboard-learn-api");
    if (existsSync(installed)) return installed;
  } catch {
    // The package is not resolvable from this layout. Fall through to the working directory.
  }
  const local = resolve(workingDirectory, "packages/blackboard-learn-api/dist/index.js");
  return existsSync(local) ? local : undefined;
}

function appendConfiguredBlackboardSource(
  config: GatewayConfig,
  environment: Readonly<Record<string, string | undefined>>,
  workingDirectory: string,
): GatewayConfig {
  if (config.profile !== "private-full" || config.upstreams.some((source) => source.id === "blackboard-rest")) return config;
  const blackboardConfigPath = resolve(environment.MORROW_BLACKBOARD_CONFIG || `${homedir()}/.morrow/blackboard-learn.json`);
  if (!existsSync(blackboardConfigPath)) return config;
  // parseGatewayConfig enforces the attestation rule before this source is appended, and this
  // source carries no attestation, so the policy is applied here instead of bypassed.
  if (config.sourcePolicy.requireAttestation) {
    return {
      ...config,
      runtimeLimitations: [...(config.runtimeLimitations ?? []), {
        code: "blackboard_attestation_required",
        setupFilePath: blackboardConfigPath,
        detail: "Blackboard Learn is set up in this file, but this configuration requires a source attestation for every source and the Blackboard runtime does not carry one, so Blackboard tools are not available. Canvas and Moodle are not affected.",
      }],
    };
  }
  const entry = resolveBlackboardRuntimeEntry(workingDirectory);
  if (!entry) {
    return {
      ...config,
      runtimeLimitations: [...(config.runtimeLimitations ?? []), {
        code: "blackboard_runtime_unavailable",
        setupFilePath: blackboardConfigPath,
        detail: "Blackboard Learn is set up in this file, but this Morrow build does not include the Blackboard runtime, so Blackboard tools are not available. Canvas and Moodle are not affected.",
      }],
    };
  }
  return {
    ...config,
    upstreams: [...config.upstreams, {
      id: "blackboard-rest",
      label: "Blackboard Learn REST",
      kind: "mcp-stdio",
      command: process.execPath,
      args: [entry],
      cwd: workingDirectory,
      env: { MORROW_BLACKBOARD_CONFIG: blackboardConfigPath },
      sourceDisposition: "direct_owned",
      priority: 175,
      required: true,
      enabled: true,
      outputPrivacy: {},
      outputPrivacyDefault: {
        allowedFields: [],
        fieldPolicy: "scrub-sensitive",
        dataClass: "learner",
        maxRecords: 10_000,
        maxBytes: 2_000_000,
        freeText: "allow",
        learnerTokens: true,
        artifactInspection: "deny",
        aiClientAdmission: "allow",
      },
    }],
  };
}

export function expandEnvironmentTemplate(
  value: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return value.replace(TEMPLATE, (_match, rawName: string, rawFallback: string | undefined) => {
    const resolved = environment[rawName];
    if (resolved !== undefined && resolved !== "") return resolved;
    if (rawFallback !== undefined) return rawFallback;
    throw new Error(`Missing environment variable ${rawName}`);
  });
}

function resolveLocalPath(
  value: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const expanded = expandEnvironmentTemplate(value, environment).trim();
  return expanded === ":memory:" ? expanded : resolve(expanded);
}

function expandUpstream(
  upstream: UpstreamConfig,
  environment: Readonly<Record<string, string | undefined>>,
): UpstreamConfig {
  if (upstream.kind === "meridian-ssh") {
    const remoteRoot = expandEnvironmentTemplate(upstream.remoteRoot, environment);
    const host = expandEnvironmentTemplate(upstream.host, environment);
    const stateDirectory = expandEnvironmentTemplate(
      upstream.runtimeProfile.stateDirectory,
      environment,
    );
    const runtimeProfile = upstream.runtimeProfile.kind === "catalog-hermetic"
      ? {
          ...upstream.runtimeProfile,
          profileId: expandEnvironmentTemplate(upstream.runtimeProfile.profileId, environment),
          localOperator: expandEnvironmentTemplate(upstream.runtimeProfile.localOperator, environment),
          sessionId: expandEnvironmentTemplate(upstream.runtimeProfile.sessionId, environment),
          stateDirectory,
        }
      : {
          ...upstream.runtimeProfile,
          profileId: expandEnvironmentTemplate(upstream.runtimeProfile.profileId, environment),
          localOperator: expandEnvironmentTemplate(upstream.runtimeProfile.localOperator, environment),
          sessionId: expandEnvironmentTemplate(upstream.runtimeProfile.sessionId, environment),
          stateDirectory,
          ...(upstream.runtimeProfile.canvasConnection
            ? {
                canvasConnection: {
                  ...upstream.runtimeProfile.canvasConnection,
                  path: expandEnvironmentTemplate(
                    upstream.runtimeProfile.canvasConnection.path,
                    environment,
                  ),
                },
              }
            : {}),
          ...(upstream.runtimeProfile.operation
            ? {
                operation: {
                  id: expandEnvironmentTemplate(upstream.runtimeProfile.operation.id, environment),
                  taskContractDigest: expandEnvironmentTemplate(
                    upstream.runtimeProfile.operation.taskContractDigest,
                    environment,
                  ).toLowerCase(),
                },
              }
            : {}),
          ...(upstream.runtimeProfile.learnerVault
            ? {
                learnerVault: {
                  vaultId: expandEnvironmentTemplate(
                    upstream.runtimeProfile.learnerVault.vaultId,
                    environment,
                  ),
                },
              }
            : {}),
        };
    return {
      ...upstream,
      host,
      remoteRoot,
      serverPath: expandEnvironmentTemplate(upstream.serverPath, environment),
      revision: upstream.revision.toLowerCase(),
      attestation: {
        ...upstream.attestation,
        host: expandEnvironmentTemplate(upstream.attestation.host, environment),
        root: expandEnvironmentTemplate(upstream.attestation.root, environment),
        expectedRevision: upstream.attestation.expectedRevision.toLowerCase(),
      },
      catalogTruth: {
        path: resolveLocalPath(upstream.catalogTruth.path, environment),
        fileSha256: expandEnvironmentTemplate(upstream.catalogTruth.fileSha256, environment).toLowerCase(),
      },
      runtimeProfile,
    };
  }
  return {
    ...upstream,
    command: expandEnvironmentTemplate(upstream.command, environment),
    args: upstream.args.map((value) => expandEnvironmentTemplate(value, environment)),
    ...(upstream.revision
      ? { revision: expandEnvironmentTemplate(upstream.revision, environment).toLowerCase() }
      : {}),
    ...(upstream.cwd
      ? { cwd: resolveLocalPath(upstream.cwd, environment) }
      : {}),
    env: Object.fromEntries(
      Object.entries(upstream.env).map(([key, value]) => [
        key,
        expandEnvironmentTemplate(value, environment),
      ]),
    ),
    ...(upstream.attestation
      ? {
          attestation: {
            ...upstream.attestation,
            root: resolveLocalPath(upstream.attestation.root, environment),
            expectedRevision: expandEnvironmentTemplate(
              upstream.attestation.expectedRevision,
              environment,
            ).toLowerCase(),
            allowedTrackedPaths: upstream.attestation.allowedTrackedPaths.map((path) => (
              expandEnvironmentTemplate(path, environment)
            )),
            ...(upstream.attestation.expectedTrackedPatchDigest
              ? {
                  expectedTrackedPatchDigest: expandEnvironmentTemplate(
                    upstream.attestation.expectedTrackedPatchDigest,
                    environment,
                  ).toLowerCase(),
                }
              : {}),
            ...(upstream.attestation.expectedCatalogDigest
              ? {
                  expectedCatalogDigest: expandEnvironmentTemplate(
                    upstream.attestation.expectedCatalogDigest,
                    environment,
                  ).toLowerCase(),
                }
              : {}),
            launch: {
              ...upstream.attestation.launch,
              entrypoint: expandEnvironmentTemplate(upstream.attestation.launch.entrypoint, environment),
              ...(upstream.attestation.launch.expectedEntrypointSha256
                ? {
                    expectedEntrypointSha256: expandEnvironmentTemplate(
                      upstream.attestation.launch.expectedEntrypointSha256,
                      environment,
                    ).toLowerCase(),
                  }
                : {}),
              ...(upstream.attestation.launch.runtime.kind === "sha256"
                ? {
                    runtime: {
                      kind: "sha256" as const,
                      expectedExecutableSha256: expandEnvironmentTemplate(
                        upstream.attestation.launch.runtime.expectedExecutableSha256,
                        environment,
                      ).toLowerCase(),
                    },
                  }
                : {}),
            },
          },
        }
      : {}),
  };
}

function validateSourceProvenance(upstream: UpstreamConfig): void {
  if (!upstream.attestation) return;
  if (!/^[0-9a-f]{40,64}$/.test(upstream.attestation.expectedRevision)) {
    throw new Error(`Upstream ${upstream.id} attestation expectedRevision must expand to a full Git object id.`);
  }
  const declaredRevision = String(upstream.revision || "").trim().toLowerCase();
  if (declaredRevision && !/^[0-9a-f]{40,64}$/.test(declaredRevision)) {
    throw new Error(`Upstream ${upstream.id} revision must expand to a full Git object id.`);
  }
  if (
    declaredRevision
    && declaredRevision !== upstream.attestation.expectedRevision.toLowerCase()
  ) {
    throw new Error(
      `Upstream ${upstream.id} declares revision ${declaredRevision} but attests ${upstream.attestation.expectedRevision}.`,
    );
  }
  if (upstream.attestation.kind === "remote-git-ssh") {
    if (upstream.kind !== "meridian-ssh") {
      throw new Error(`Upstream ${upstream.id} cannot use remote ExamplePlatform attestation.`);
    }
    if (upstream.host !== upstream.attestation.host || upstream.remoteRoot !== upstream.attestation.root) {
      throw new Error(
        `Upstream ${upstream.id} launch and attestation must use the same SSH host and remote root.`,
      );
    }
    if (!/^[0-9a-f]{64}$/.test(upstream.catalogTruth.fileSha256)) {
      throw new Error(`Upstream ${upstream.id} catalog truth digest must expand to SHA-256.`);
    }
    return;
  }
  if (upstream.kind !== "mcp-stdio") {
    throw new Error(`Upstream ${upstream.id} cannot use local Git attestation.`);
  }
  if (
    upstream.attestation.requireTrackedClean
    && upstream.attestation.allowedTrackedPaths.length > 0
  ) {
    throw new Error(
      `Upstream ${upstream.id} cannot require a clean tree while allowing tracked overlay paths.`,
    );
  }
  if (
    !upstream.attestation.requireTrackedClean
    && upstream.attestation.allowedTrackedPaths.length === 0
  ) {
    throw new Error(
      `Upstream ${upstream.id} must name every allowed tracked overlay path.`,
    );
  }
  if (!upstream.cwd) {
    throw new Error(`Upstream ${upstream.id} attestation requires an explicit launch working directory.`);
  }
  if (resolve(upstream.cwd) !== resolve(upstream.attestation.root)) {
    throw new Error(`Upstream ${upstream.id} launch and attestation must use the same local worktree root.`);
  }
  if (upstream.attestation.launch.entrypointArgumentIndex >= upstream.args.length) {
    throw new Error(`Upstream ${upstream.id} attestation entrypoint argument does not exist.`);
  }
  for (const [label, digest] of [
    ["tracked patch", upstream.attestation.expectedTrackedPatchDigest],
    ["catalog", upstream.attestation.expectedCatalogDigest],
    ["entrypoint", upstream.attestation.launch.expectedEntrypointSha256],
    ["executable", upstream.attestation.launch.runtime.kind === "sha256"
      ? upstream.attestation.launch.runtime.expectedExecutableSha256
      : undefined],
  ] as const) {
    if (digest && !/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`Upstream ${upstream.id} ${label} digest must expand to SHA-256.`);
    }
  }
}

export function parseGatewayConfig(
  value: unknown,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): GatewayConfig {
  const parsed = GatewayConfigSchema.parse(value);
  const upstreams = parsed.upstreams
    .filter((upstream) => upstream.enabled)
    .map((upstream) => expandUpstream(upstream, environment));
  if (upstreams.length === 0) {
    throw new Error("At least one enabled upstream is required");
  }
  assertUniqueCanonicalUpstreamIds(upstreams);
  const requireSourceAttestation = parsed.sourcePolicy.requireAttestation
    || parsed.profile === "public-canvas";
  for (const upstream of upstreams) {
    validateSourceProvenance(upstream);
    if (requireSourceAttestation && !upstream.attestation) {
      throw new Error(`Upstream ${upstream.id} requires a configured source attestation.`);
    }
    if (
      parsed.profile === "public-canvas"
      && !["direct_owned", "adapted_owned", "clean_reimplementation"].includes(upstream.sourceDisposition)
    ) {
      throw new Error(`public-canvas profile refuses ${upstream.sourceDisposition} upstream ${upstream.id}.`);
    }
    if (parsed.profile === "sandbox") {
      if (upstream.id !== "sandbox" || upstream.kind !== "mcp-stdio") {
        throw new Error("sandbox profile accepts only the local synthetic sandbox upstream");
      }
      if (upstream.env.MORROW_SANDBOX !== "1" || upstream.env.MORROW_ALLOW_EXTERNAL_NETWORK !== "0") {
        throw new Error("sandbox profile requires synthetic mode and disabled external network access");
      }
    }
  }
  const publicationPath = parsed.publicationPolicy.path
    ? resolveLocalPath(parsed.publicationPolicy.path, environment)
    : undefined;
  if (
    parsed.profile === "public-canvas"
    && parsed.publicationPolicy.requiredForPublicProfile
    && !publicationPath
  ) {
    throw new Error("public-canvas profile requires publicationPolicy.path");
  }
  return {
    ...parsed,
    upstreams,
    sourcePolicy: {
      requireAttestation: requireSourceAttestation,
    },
    publicationPolicy: {
      requiredForPublicProfile: parsed.publicationPolicy.requiredForPublicProfile,
      ...(publicationPath ? { path: publicationPath } : {}),
    },
    operationJournal: {
      path: resolveLocalPath(parsed.operationJournal.path, environment),
    },
    privacy: {
      ...parsed.privacy,
      learnerVaultPath: resolveLocalPath(parsed.privacy.learnerVaultPath, environment),
    },
  };
}

export async function loadGatewayConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  workingDirectory = process.cwd(),
): Promise<GatewayConfig> {
  const configuredPath = environment.MORROW_UPSTREAMS_FILE?.trim();
  const path = resolve(workingDirectory, configuredPath || "morrow.upstreams.json");

  if (existsSync(path)) {
    const raw = readExactTrustJson(path, {
      label: "Gateway configuration",
      maxBytes: MAX_GATEWAY_CONFIG_BYTES,
    });
    const parsed = parseGatewayConfig(raw, environment);
    const config: GatewayConfig = {
      ...parsed,
      upstreams: parsed.upstreams.map((upstream) => (
        upstream.kind === "mcp-stdio" && !upstream.cwd
          ? { ...upstream, cwd: dirname(path) }
          : upstream
      )),
    };
    if (config.upstreams.some((upstream) => upstream.id.toLowerCase() === "meridian" && upstream.kind !== "meridian-ssh")) {
      throw new Error("ExamplePlatform must run through a meridian-ssh upstream.");
    }
    return appendConfiguredBlackboardSource(config, environment, workingDirectory);
  }

  if (environment.MORROW_MERIDIAN_SERVER_PATH?.trim()) {
    throw new Error(
      "MORROW_MERIDIAN_SERVER_PATH cannot start ExamplePlatform locally. Use a meridian-ssh upstream configuration.",
    );
  }

  const connectorEntry = resolve(workingDirectory, "packages/canvas-connector-mcp/dist/index.js");
  const catalogPath = resolve(workingDirectory, "artifacts/canvas-api/canvas-api-catalog.json");
  if (existsSync(connectorEntry) && existsSync(catalogPath)) {
    return appendConfiguredBlackboardSource(parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      profile: "private-full",
      upstreams: [{
        id: "canvas-session",
        label: "Morrow Bridge",
        kind: "mcp-stdio",
        command: process.execPath,
        args: [connectorEntry],
        cwd: workingDirectory,
        env: { MORROW_CANVAS_CATALOG_PATH: catalogPath },
        sourceDisposition: "direct_owned",
        priority: 200,
        required: true,
        enabled: true,
        outputPrivacy: {},
        outputPrivacyDefault: {
          allowedFields: [],
          fieldPolicy: "scrub-sensitive",
          dataClass: "learner",
          maxRecords: 10_000,
          maxBytes: 2_000_000,
          freeText: "allow",
          learnerTokens: true,
          artifactInspection: "deny",
          aiClientAdmission: "allow",
        },
      }],
      sourcePolicy: { requireAttestation: false },
      publicationPolicy: { requiredForPublicProfile: false },
      filters: { excludePrefixes: ["mindtap_", "connect_"], excludeNames: [] },
      operationJournal: { path: resolve(workingDirectory, ".morrow/morrow.sqlite3") },
      batchScheduler: { maxConcurrentReadWindows: 2 },
      privacy: {
        canvasOrigin: "browser-session",
        account: "local-browser-account",
        principal: "local-browser-principal",
        learnerVaultPath: resolve(workingDirectory, ".morrow/learner-vault.json"),
      },
      maxCatalogTools: 2_000,
    }, environment), environment, workingDirectory);
  }

  throw new Error(
    `No Morrow configuration found at ${path}. Run pnpm build, then run morrow setup.`,
  );
}
