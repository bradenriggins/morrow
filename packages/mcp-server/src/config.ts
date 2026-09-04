import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as z from "zod/v4";
import { SOURCE_DISPOSITIONS } from "@morrow/gateway-core";

const EnvironmentName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const FullGitRevision = z.string().regex(/^[0-9a-fA-F]{40,64}$/);
const Sha256Digest = z.string().regex(/^[0-9a-fA-F]{64}$/);
const RepositoryRelativePath = z.string().min(1).max(500);
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
  id: z.string().min(1),
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
});

const UpstreamSchema = z.discriminatedUnion("kind", [
  StdioUpstreamSchema,
  ExamplePlatformSshUpstreamSchema,
]);

const GatewayConfigSchema = z.object({
  schema: z.literal("morrow.upstreams.v1"),
  profile: z.enum(["private-full", "public-canvas", "sandbox", "read-only"]).default("private-full"),
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
    maxConcurrentWindows: z.number().int().min(1).max(16).default(1),
  }).default({ maxConcurrentWindows: 1 }),
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
  maxCatalogTools: z.number().int().positive().max(5000).default(1000),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
export type UpstreamConfig = z.infer<typeof UpstreamSchema>;
export type StdioUpstreamConfig = Extract<UpstreamConfig, { kind: "mcp-stdio" }>;
export type ExamplePlatformSshUpstreamConfig = Extract<UpstreamConfig, { kind: "meridian-ssh" }>;
export type LocalGitAttestationConfig = z.infer<typeof LocalGitAttestationSchema>;
export type RemoteGitSshAttestationConfig = z.infer<typeof RemoteGitSshAttestationSchema>;

const TEMPLATE = /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g;

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
        fileSha256: upstream.catalogTruth.fileSha256.toLowerCase(),
      },
      runtimeProfile,
    };
  }
  return {
    ...upstream,
    command: expandEnvironmentTemplate(upstream.command, environment),
    args: upstream.args.map((value) => expandEnvironmentTemplate(value, environment)),
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
            expectedRevision: upstream.attestation.expectedRevision.toLowerCase(),
            allowedTrackedPaths: upstream.attestation.allowedTrackedPaths.map((path) => (
              expandEnvironmentTemplate(path, environment)
            )),
            ...(upstream.attestation.expectedTrackedPatchDigest
              ? {
                  expectedTrackedPatchDigest: upstream.attestation.expectedTrackedPatchDigest.toLowerCase(),
                }
              : {}),
            ...(upstream.attestation.expectedCatalogDigest
              ? { expectedCatalogDigest: upstream.attestation.expectedCatalogDigest.toLowerCase() }
              : {}),
          },
        }
      : {}),
  };
}

function validateSourceProvenance(upstream: UpstreamConfig): void {
  if (!upstream.attestation) return;
  const declaredRevision = String(upstream.revision || "").trim().toLowerCase();
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
    return;
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
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
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
    return config;
  }

  if (environment.MORROW_MERIDIAN_SERVER_PATH?.trim()) {
    throw new Error(
      "MORROW_MERIDIAN_SERVER_PATH cannot start ExamplePlatform locally. Use a meridian-ssh upstream configuration.",
    );
  }

  throw new Error(
    `No upstream configuration found at ${path}. Copy a meridian SSH upstream example `
      + "to morrow.upstreams.json.",
  );
}
