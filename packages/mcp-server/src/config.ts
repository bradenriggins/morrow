import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as z from "zod/v4";

const EnvironmentName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);

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
  priority: z.number().int().default(0),
  required: z.boolean().default(true),
  enabled: z.boolean().default(true),
});

const GatewayConfigSchema = z.object({
  schema: z.literal("morrow.upstreams.v1"),
  profile: z.enum(["private-full", "public-canvas"]).default("private-full"),
  upstreams: z.array(StdioUpstreamSchema).min(1),
  filters: z.object({
    excludePrefixes: z.array(z.string()).default(["mindtap_", "connect_"]),
    excludeNames: z.array(z.string()).default([]),
  }).default({
    excludePrefixes: ["mindtap_", "connect_"],
    excludeNames: [],
  }),
  maxCatalogTools: z.number().int().positive().max(5000).default(1000),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
export type StdioUpstreamConfig = z.infer<typeof StdioUpstreamSchema>;

const TEMPLATE = /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g;

export function expandEnvironmentTemplate(
  value: string,
  environment: Readonly<Record<string, string | undefined>>,
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
  };
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
  return {
    ...parsed,
    upstreams,
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
    return parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      profile: "private-full",
      upstreams: [{
        id: "meridian",
        label: "ExamplePlatform",
        kind: "mcp-stdio",
        command: environment.MORROW_PYTHON_COMMAND?.trim() || "python3",
        args: [meridianServerPath],
        repository: "example-owner/example-attestation-repo",
        revision: "7cc052cf2063e1f2492c0ac20aee41ee3a22a10f",
        priority: 100,
        required: true,
        enabled: true,
      }],
      filters: {
        excludePrefixes: ["mindtap_", "connect_"],
        excludeNames: [],
      },
      maxCatalogTools: 1000,
    }, environment);
  }

  throw new Error(
    `No upstream configuration found at ${path}. Copy morrow.upstreams.example.json `
      + "to morrow.upstreams.json or set MORROW_MERIDIAN_SERVER_PATH.",
  );
}
