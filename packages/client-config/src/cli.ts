#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  buildClientParityReport,
  installMorrowClient,
  MORROW_CLIENT_SCOPES,
  SUPPORTED_MORROW_CLIENTS,
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
    "  morrow mcp install <codex|claude|gemini> --upstreams <absolute-path> [--scope project] [options]",
    "  morrow doctor --json [--upstreams <absolute-path>] [--repository <path>]",
    "  morrow conformance --upstreams <absolute-path> --json [options]",
    "  morrow clients render --upstreams <absolute-path> [options]",
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
  if (!options.upstreamConfigPath) throw new Error("--upstreams is required");
  const { outputDirectory: _outputDirectory, force: _force, ...bundle } = options;
  return bundle;
}

function exactClient(value: string | undefined): SupportedMorrowClient {
  const normalized = value === "claude" ? "claude-code" : value === "gemini" ? "gemini-cli" : value;
  if (!(SUPPORTED_MORROW_CLIENTS as readonly string[]).includes(String(normalized))) {
    throw new Error("client must be codex, claude, or gemini");
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

function doctor(options: SharedOptions): Record<string, unknown> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const serverEntryPath = options.serverEntryPath || resolve(repositoryRoot, "packages/mcp-server/dist/index.js");
  return {
    schema: "morrow.doctor.v1",
    repositoryRoot,
    serverEntryPath,
    serverEntryExists: existsSync(serverEntryPath),
    upstreamConfigPath: options.upstreamConfigPath || null,
    upstreamConfigExists: Boolean(options.upstreamConfigPath) && existsSync(options.upstreamConfigPath),
    projectScopeDefault: true,
    clients: {
      codex: commandAvailable("codex"),
      claude: commandAvailable("claude"),
      gemini: commandAvailable("gemini"),
    },
  };
}

function run(): void {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help") {
    process.stdout.write(usage());
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

  if (command === "doctor") {
    const { options, json } = parseSharedOptions(rest);
    if (!json) throw new Error("doctor requires --json");
    process.stdout.write(`${JSON.stringify(doctor(options))}\n`);
    return;
  }

  if (command === "conformance") {
    const { options, json } = parseSharedOptions(rest);
    if (!json) throw new Error("conformance requires --json");
    process.stdout.write(`${JSON.stringify(buildClientParityReport(requireUpstreams(options)))}\n`);
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
  run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[morrow] ${message}\n\n${usage()}`);
  process.exitCode = 1;
}
