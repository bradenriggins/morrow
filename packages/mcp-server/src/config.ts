import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as z from "zod/v4";

const EnvironmentName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const FullGitRevision = z.string().regex(/^[0-9a-fA-F]{40,64}$/);
const Sha256Digest = z.string().regex(/^[0-9a-fA-F]{64}$/);

const LocalGitAttestationSchema = z.object({
  kind: z.literal("local-git"),
  root: z.string().min(1),
  expectedRevision: FullGitRevision,
  requireTrackedClean: z.boolean().default(true),
  expectedToolCount: z.number().int().min(1).max(5000).optional(),
  expectedCatalogDigest: Sha256Digest.optional(),
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
  attestation: LocalGitAttestationSchema.optional(),
  priority: z.number().int().default(0),
  required: z.boolean().default(true),
  enabled: z.boolean().default(true),
});

const GatewayConfigSchema = z.object({
  schema: z.literal("morrow.upstreams.v1"),
  profile: z.enum(["private-full", "public-canvas"]).default("private-full"),
  upstreams: z.array(StdioUpstreamSchema).min(1),
  sourcePolicy: z.object({
    requireAttestation: z.boolean().default(false),
  }).default({ requireAttestation: false }),
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
  maxCatalogTools: z.number().int().positive().max(5000).default(1000),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
export type StdioUpstreamConfig = z.infer<typeof StdioUpstreamSchema>;
export type LocalGitAttestationConfig = z.infer<typeof LocalGitAttestationSchema>;

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

function expandUpstream(
  upstream: StdioUpstreamConfig,
  environment: Readonly<Record<string, string | undefined>>,
): StdioUpstreamConfig {
  return {
    ...upstream,
    command: expandEnvironmentTemplate(upstream.command, environment),
    args: upstream.args.map((value) => expandEnvironmentTemplate(value, environment)),
    ...(upstream.cwd
      ? { cwd: expandEnvironmentTemplate(upstream.cwd, environment) }
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
            root: expandEnvironmentTemplate(upstream.attestation.root, environment),
            expectedRevision: upstream.attestation.expectedRevision.toLowerCase(),
            ...(upstream.attestation.expectedCatalogDigest
              ? { expectedCatalogDigest: upstream.attestation.expectedCatalogDigest.toLowerCase() }
              : {}),
          },
        }
      : {}),
  };
}

function validateSourceProvenance(upstream: StdioUpstreamConfig): void {
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
  for (const upstream of upstreams) {
    validateSourceProvenance(upstream);
    if (parsed.sourcePolicy.requireAttestation && !upstream.attestation) {
      throw new Error(`Upstream ${upstream.id} requires a configured source attestation.`);
    }
  }
  return {
    ...parsed,
    upstreams,
    operationJournal: {
      path: expandEnvironmentTemplate(parsed.operationJournal.path, environment),
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
    return parseGatewayConfig(raw, environment);
  }

  const meridianServerPath = environment.MORROW_MERIDIAN_SERVER_PATH?.trim();
  if (meridianServerPath) {
    const meridianRoot = environment.MORROW_MERIDIAN_ROOT?.trim();
    return parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      profile: "private-full",
      sourcePolicy: {
        requireAttestation: Boolean(meridianRoot),
      },
      upstreams: [{
        id: "meridian",
        label: "ExamplePlatform",
        kind: "mcp-stdio",
        command: environment.MORROW_PYTHON_COMMAND?.trim() || "python3",
        args: [meridianServerPath],
        repository: "example-owner/example-attestation-repo",
        revision: "7cc052cf2063e1f2492c0ac20aee41ee3a22a10f",
        ...(meridianRoot
          ? {
              attestation: {
                kind: "local-git",
                root: meridianRoot,
                expectedRevision: "7cc052cf2063e1f2492c0ac20aee41ee3a22a10f",
                requireTrackedClean: true,
                expectedToolCount: 205,
              },
            }
          : {}),
        priority: 100,
        required: true,
        enabled: true,
      }],
      filters: {
        excludePrefixes: ["mindtap_", "connect_"],
        excludeNames: [],
      },
      operationJournal: {
        path: "${MORROW_OPERATION_DB_PATH:-.morrow/morrow.sqlite3}",
      },
      batchScheduler: {
        maxConcurrentWindows: 1,
      },
      maxCatalogTools: 1000,
    }, environment);
  }

  throw new Error(
    `No upstream configuration found at ${path}. Copy morrow.upstreams.example.json `
      + "to morrow.upstreams.json or set MORROW_MERIDIAN_SERVER_PATH.",
  );
}
