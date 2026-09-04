#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { sha256Text } from "@morrow/contracts";
import {
  buildClientConfigBundle,
  buildClientParityReport,
  installMorrowClient,
  MORROW_CLIENT_SCOPES,
  SUPPORTED_MORROW_CLIENTS,
  writeLocalCanvasConfig,
  writeClientConfigBundle,
  type ClientConfigBundleOptions,
  type MorrowClientScope,
  type SupportedMorrowClient,
} from "./index.js";

interface SharedOptions extends ClientConfigBundleOptions {
  readonly outputDirectory?: string;
  readonly force: boolean;
}

function usage(): string {
  return [
    "Usage:",
    "  morrow setup [--repository <path>] [--force] [--json]",
    "  morrow mcp install <codex|claude|claude-desktop|gemini> [--scope project|user] [options]",
    "  morrow doctor --json [--upstreams <absolute-path>] [--repository <path>]",
    "  morrow profile show [--json] [--upstreams <absolute-path>]",
    "  morrow catalog stats [--json] [--repository <path>]",
    "  morrow backend status [--json] --upstreams <absolute-path>",
    "  morrow operation <get|reconcile|cancel> <operation-id> [--json] --upstreams <absolute-path>",
    "  morrow batch <get|pause|cancel> <batch-id> [--json] --upstreams <absolute-path>",
    "  morrow batch resume <batch-id> --course-set-digest <sha256> --profile-digest <sha256> [--max-children <count>] [--json] --upstreams <absolute-path>",
    "  morrow conformance report [--json] [--repository <path>]",
    "  morrow clients render --upstreams <absolute-path> [options]",
    "  morrow mcp print-config inspector --upstreams <absolute-path> [options]",
    "",
    "Options:",
    "  --repository <path>       Morrow repository root. Defaults to the current directory.",
    "  --upstreams <path>        Absolute path to local morrow.upstreams.json.",
    "  --scope <project|user>    Configuration scope. Defaults to project.",
    "  --output <path>           Bundle output directory. Defaults to <repository>/.morrow/client-configs.",
    "  --server-entry <path>     Absolute compiled server entry path.",
    "  --node <command>          Node executable. Defaults to the current Node executable.",
    "  --name <name>             MCP server name. Defaults to morrow.",
    "  --startup-timeout <sec>   Codex startup timeout. Defaults to 60.",
    "  --tool-timeout <sec>      Codex tool timeout. Defaults to 900.",
    "  --gemini-timeout <ms>     Gemini request timeout. Defaults to tool timeout in milliseconds.",
    "  --force                   Replace existing generated bundle files only.",
    "  --json                    Emit machine-readable output for doctor or conformance.",
    "  --help                    Show this help.",
    "",
  ].join("\n");
}

function nextValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function positiveInteger(value: string, flag: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${flag} requires a positive whole number`);
  return Number(value);
}

function exactDigest(value: string, flag: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${flag} requires a lowercase SHA-256 digest`);
  return value;
}

function parseBatchResumeOptions(args: readonly string[]): {
  readonly courseSetDigest: string;
  readonly profileDigest: string;
  readonly maxChildren: number;
  readonly sharedArgs: readonly string[];
} {
  let courseSetDigest = "";
  let profileDigest = "";
  let maxChildren = 50;
  const sharedArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!["--course-set-digest", "--profile-digest", "--max-children"].includes(flag)) {
      sharedArgs.push(flag);
      continue;
    }
    const value = nextValue(args, index, flag);
    index += 1;
    if (flag === "--course-set-digest") courseSetDigest = exactDigest(value, flag);
    if (flag === "--profile-digest") profileDigest = exactDigest(value, flag);
    if (flag === "--max-children") maxChildren = positiveInteger(value, flag);
  }
  if (!courseSetDigest) throw new Error("batch resume requires --course-set-digest");
  if (!profileDigest) throw new Error("batch resume requires --profile-digest");
  if (maxChildren > 500) throw new Error("--max-children cannot exceed 500");
  return { courseSetDigest, profileDigest, maxChildren, sharedArgs };
}

function parseSharedOptions(args: readonly string[]): { readonly options: SharedOptions; readonly json: boolean } {
  let repositoryRoot = process.cwd();
  let upstreamConfigPath = "";
  let outputDirectory: string | undefined;
  let serverName: string | undefined;
  let nodeCommand: string | undefined;
  let serverEntryPath: string | undefined;
  let startupTimeoutSeconds: number | undefined;
  let toolTimeoutSeconds: number | undefined;
  let geminiTimeoutMilliseconds: number | undefined;
  let force = false;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === "--help") {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (flag === "--force") {
      force = true;
      continue;
    }
    if (flag === "--json") {
      json = true;
      continue;
    }
    const value = nextValue(args, index, flag);
    index += 1;
    switch (flag) {
      case "--repository": repositoryRoot = resolve(value); break;
      case "--upstreams": upstreamConfigPath = resolve(value); break;
      case "--output": outputDirectory = resolve(value); break;
      case "--server-entry": serverEntryPath = resolve(value); break;
      case "--node": nodeCommand = value; break;
      case "--name": serverName = value; break;
      case "--startup-timeout": startupTimeoutSeconds = positiveInteger(value, flag); break;
      case "--tool-timeout": toolTimeoutSeconds = positiveInteger(value, flag); break;
      case "--gemini-timeout": geminiTimeoutMilliseconds = positiveInteger(value, flag); break;
      default: throw new Error(`Unknown option ${flag}`);
    }
  }

  return {
    options: {
      repositoryRoot,
      upstreamConfigPath,
      ...(outputDirectory ? { outputDirectory } : {}),
      ...(serverName ? { serverName } : {}),
      ...(nodeCommand ? { nodeCommand } : {}),
      ...(serverEntryPath ? { serverEntryPath } : {}),
      ...(startupTimeoutSeconds !== undefined ? { startupTimeoutSeconds } : {}),
      ...(toolTimeoutSeconds !== undefined ? { toolTimeoutSeconds } : {}),
      ...(geminiTimeoutMilliseconds !== undefined ? { geminiTimeoutMilliseconds } : {}),
      force,
    },
    json,
  };
}

function requireUpstreams(options: SharedOptions): ClientConfigBundleOptions {
  const upstreamConfigPath = options.upstreamConfigPath
    || (process.env.MORROW_UPSTREAMS_FILE ? resolve(process.env.MORROW_UPSTREAMS_FILE) : "")
    || (existsSync(resolve(options.repositoryRoot, "morrow.upstreams.json")) ? resolve(options.repositoryRoot, "morrow.upstreams.json") : "");
  if (!upstreamConfigPath) throw new Error("--upstreams is required when MORROW_UPSTREAMS_FILE is not set");
  const { outputDirectory: _outputDirectory, force: _force, ...bundle } = options;
  return { ...bundle, upstreamConfigPath };
}

function exactClient(value: string | undefined): SupportedMorrowClient {
  const normalized = value === "claude" ? "claude-code" : value === "gemini" ? "gemini-cli" : value;
  if (!(SUPPORTED_MORROW_CLIENTS as readonly string[]).includes(String(normalized))) {
    throw new Error("client must be codex, claude, claude-desktop, or gemini");
  }
  return normalized as SupportedMorrowClient;
}

function parseScope(args: readonly string[]): { readonly scope: MorrowClientScope; readonly rest: readonly string[] } {
  let scope: MorrowClientScope = "project";
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--scope") {
      rest.push(args[index]!);
      continue;
    }
    const value = nextValue(args, index, "--scope");
    index += 1;
    if (!(MORROW_CLIENT_SCOPES as readonly string[]).includes(value)) {
      throw new Error("--scope must be project or user");
    }
    scope = value as MorrowClientScope;
  }
  return { scope, rest };
}

function commandAvailable(command: string): boolean {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return !result.error;
}

async function doctor(options: SharedOptions): Promise<Record<string, unknown>> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const serverEntryPath = options.serverEntryPath || resolve(repositoryRoot, "packages/mcp-server/dist/index.js");
  const upstreamConfigPath = options.upstreamConfigPath
    || (process.env.MORROW_UPSTREAMS_FILE ? resolve(process.env.MORROW_UPSTREAMS_FILE) : "")
    || resolve(repositoryRoot, "morrow.upstreams.json");
  const upstreamConfigExists = Boolean(upstreamConfigPath) && existsSync(upstreamConfigPath);
  let runtime: Record<string, unknown> = {
    attempted: false,
    ready: false,
    reason: upstreamConfigPath ? "upstream_config_missing" : "upstream_config_not_selected",
  };
  if (existsSync(serverEntryPath) && upstreamConfigExists) {
    try {
      const health = await callMorrowTool(
        { ...options, repositoryRoot, serverEntryPath, upstreamConfigPath },
        "morrow_health",
        {},
      );
      runtime = health && typeof health === "object" && !Array.isArray(health)
        ? { attempted: true, ...(health as Record<string, unknown>) }
        : { attempted: true, ready: false, reason: "invalid_health_result" };
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
      runtime = {
        attempted: true,
        ready: false,
        reason: "runtime_probe_failed",
        detailDigest: sha256Text(detail),
      };
    }
  }
  return {
    schema: "morrow.doctor.v1",
    repositoryRoot,
    serverEntryPath,
    serverEntryExists: existsSync(serverEntryPath),
    upstreamConfigPath: upstreamConfigPath || null,
    upstreamConfigExists,
    projectScopeDefault: true,
    clients: {
      codex: commandAvailable("codex"),
      claude: commandAvailable("claude"),
      gemini: commandAvailable("gemini"),
    },
    runtime,
  };
}

function emit(value: unknown, json: boolean): void {
  if (json || typeof value !== "object" || value === null) {
    process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must contain a JSON object`);
  return value as Record<string, unknown>;
}

function profileShow(options: SharedOptions): Record<string, unknown> {
  const configPath = requireUpstreams(options).upstreamConfigPath;
  if (!existsSync(configPath)) throw new Error(`upstream configuration does not exist: ${configPath}`);
  const config = readJson(configPath);
  const upstreams = Array.isArray(config.upstreams) ? config.upstreams : [];
  return {
    schema: "morrow.profile-status.v1",
    profile: config.profile || "private-full",
    upstreamConfigPath: configPath,
    upstreams: upstreams.map((value) => {
      const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
      return { id: source.id, kind: source.kind, enabled: source.enabled !== false, required: source.required !== false };
    }),
  };
}

function catalogStats(repositoryRoot: string): Record<string, unknown> {
  const root = resolve(repositoryRoot);
  const catalogPath = resolve(root, "artifacts/canvas-api/canvas-api-catalog.json");
  if (!existsSync(catalogPath)) throw new Error(`catalog artifact does not exist: ${catalogPath}`);
  const catalog = readJson(catalogPath);
  const counts = catalog.counts && typeof catalog.counts === "object" && !Array.isArray(catalog.counts)
    ? catalog.counts as Record<string, unknown>
    : {};
  return {
    schema: "morrow.catalog-stats.v1",
    catalogDigest: catalog.catalogDigest,
    operationCount: counts.totalOperations || 0,
    officialOperationCount: counts.officialOperations || 0,
    browserSessionOperationCount: counts.browserSessionOperations || 0,
    readCount: counts.reads || 0,
    writeCount: counts.writes || 0,
    newQuizzesOperationCount: counts.newQuizzesOperations || 0,
    itemBankOperationCount: counts.itemBankOperations || 0,
    source: catalog.source,
  };
}

async function callMorrowTool(
  options: SharedOptions,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const bundle = requireUpstreams(options);
  const serverEntryPath = bundle.serverEntryPath || resolve(bundle.repositoryRoot, "packages/mcp-server/dist/index.js");
  const client = new Client({ name: "morrow-cli", version: "1.0.0-rc.0" });
  const transport = new StdioClientTransport({
    command: bundle.nodeCommand || process.execPath,
    args: [serverEntryPath],
    cwd: bundle.repositoryRoot,
    env: { ...process.env, MORROW_UPSTREAMS_FILE: bundle.upstreamConfigPath } as Record<string, string>,
    stderr: "inherit",
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args });
    return result.structuredContent || result;
  } finally {
    await client.close();
  }
}

function runConformance(repositoryRoot: string): never | void {
  const result = spawnSync(process.execPath, [resolve(repositoryRoot, "scripts/conformance-report.mjs")], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

async function run(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help") {
    process.stdout.write(usage());
    return;
  }

  if (command === "setup") {
    const { options, json } = parseSharedOptions(rest);
    const configured = writeLocalCanvasConfig({
      repositoryRoot: options.repositoryRoot,
      ...(options.nodeCommand ? { nodeCommand: options.nodeCommand } : {}),
      force: options.force,
    });
    emit({
      schema: "morrow.setup.v1",
      ...configured,
      serverEntryPath: resolve(options.repositoryRoot, "packages/mcp-server/dist/index.js"),
      installs: ["Morrow MCP", "Morrow Canvas Connector extension"],
      credentialsCopied: false,
    }, json);
    return;
  }

  if (command === "mcp" && rest[0] === "install") {
    const client = exactClient(rest[1]);
    const { scope, rest: optionArgs } = parseScope(rest.slice(2));
    const { options, json } = parseSharedOptions(optionArgs);
    const installed = installMorrowClient({ ...requireUpstreams(options), client, scope });
    if (json) process.stdout.write(`${JSON.stringify(installed)}\n`);
    else process.stdout.write(`client=${installed.client}\nscope=${installed.scope}\npath=${installed.path}\nchanged=${installed.changed}\n`);
    return;
  }

  if (command === "mcp" && rest[0] === "print-config" && rest[1] === "inspector") {
    const { options, json } = parseSharedOptions(rest.slice(2));
    const bundle = buildClientConfigBundle(requireUpstreams(options));
    emit({
      schema: "morrow.inspector-config.v1",
      transport: bundle.transport,
      command: bundle.command,
      args: bundle.args,
      cwd: bundle.cwd,
      env: { MORROW_UPSTREAMS_FILE: requireUpstreams(options).upstreamConfigPath },
    }, json);
    return;
  }

  if (command === "doctor") {
    const { options, json } = parseSharedOptions(rest);
    if (!json) throw new Error("doctor requires --json");
    process.stdout.write(`${JSON.stringify(await doctor(options))}\n`);
    return;
  }

  if (command === "profile" && rest[0] === "show") {
    const { options, json } = parseSharedOptions(rest.slice(1));
    emit(profileShow(options), json);
    return;
  }

  if (command === "catalog" && rest[0] === "stats") {
    const { options, json } = parseSharedOptions(rest.slice(1));
    emit(catalogStats(options.repositoryRoot), json);
    return;
  }

  if (command === "backend" && rest[0] === "status") {
    const { options, json } = parseSharedOptions(rest.slice(1));
    emit(await callMorrowTool(options, "morrow_health", {}), json);
    return;
  }

  if (command === "operation" && ["get", "reconcile", "cancel"].includes(rest[0] || "")) {
    const action = rest[0]!;
    const operationId = rest[1];
    if (!operationId || operationId.startsWith("--")) throw new Error(`operation ${action} requires an operation ID`);
    const { options, json } = parseSharedOptions(rest.slice(2));
    emit(await callMorrowTool(options, `morrow_operation_${action}`, { operation_id: operationId }), json);
    return;
  }

  if (command === "batch" && ["get", "pause", "resume", "cancel"].includes(rest[0] || "")) {
    const action = rest[0]!;
    const batchId = rest[1];
    if (!batchId || batchId.startsWith("--")) throw new Error(`batch ${action} requires a batch ID`);
    const resume = action === "resume" ? parseBatchResumeOptions(rest.slice(2)) : null;
    const { options, json } = parseSharedOptions(resume?.sharedArgs || rest.slice(2));
    emit(await callMorrowTool(options, `morrow_batch_${action}`, {
      batch_id: batchId,
      ...(resume ? {
        course_set_digest: resume.courseSetDigest,
        profile_digest: resume.profileDigest,
        max_children: resume.maxChildren,
      } : {}),
    }), json);
    return;
  }

  if (command === "conformance" && rest[0] === "report") {
    const { options } = parseSharedOptions(rest.slice(1));
    runConformance(options.repositoryRoot);
    return;
  }

  if (command === "conformance") {
    const { options, json } = parseSharedOptions(rest);
    if (!json) throw new Error("client parity conformance requires --json");
    emit(buildClientParityReport(requireUpstreams(options)), true);
    return;
  }

  if (command === "clients" && rest[0] === "render") {
    const { options } = parseSharedOptions(rest.slice(1));
    const bundleOptions = requireUpstreams(options);
    const outputDirectory = options.outputDirectory || resolve(bundleOptions.repositoryRoot, ".morrow/client-configs");
    const bundle = writeClientConfigBundle({ ...bundleOptions, outputDirectory, force: options.force });
    process.stdout.write(`output=${outputDirectory}\nserver=${bundle.serverName}\ntransport=${bundle.transport}\nfiles=${bundle.files.length}\n`);
    return;
  }

  throw new Error(`Unknown command ${command}`);
}

try {
  await run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[morrow] ${message}\n\n${usage()}`);
  process.exitCode = 1;
}
