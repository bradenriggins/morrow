#!/usr/bin/env node
import { resolve } from "node:path";
import { writeClientConfigBundle } from "./index.js";

interface ParsedArguments {
  readonly repositoryRoot: string;
  readonly upstreamConfigPath: string;
  readonly outputDirectory: string;
  readonly serverName?: string;
  readonly nodeCommand?: string;
  readonly serverEntryPath?: string;
  readonly startupTimeoutSeconds?: number;
  readonly toolTimeoutSeconds?: number;
  readonly geminiTimeoutMilliseconds?: number;
  readonly force: boolean;
}

function usage(): string {
  return [
    "Usage: morrow-client-config --upstreams <absolute-path> [options]",
    "",
    "Options:",
    "  --repository <path>       Morrow repository root. Defaults to the current directory.",
    "  --upstreams <path>        Absolute path to the local morrow.upstreams.json file.",
    "  --output <path>           Output directory. Defaults to <repository>/.morrow/client-configs.",
    "  --server-entry <path>     Absolute compiled server entry path.",
    "  --node <command>          Node executable. Defaults to the current Node executable.",
    "  --name <name>             MCP server name. Defaults to morrow.",
    "  --startup-timeout <sec>   Codex startup timeout. Defaults to 60.",
    "  --tool-timeout <sec>      Codex tool timeout. Defaults to 900.",
    "  --gemini-timeout <ms>     Gemini request timeout. Defaults to tool timeout in milliseconds.",
    "  --force                   Replace existing generated files.",
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

function parseArguments(args: readonly string[]): ParsedArguments {
  let repositoryRoot = process.cwd();
  let upstreamConfigPath = "";
  let outputDirectory = "";
  let serverName: string | undefined;
  let nodeCommand: string | undefined;
  let serverEntryPath: string | undefined;
  let startupTimeoutSeconds: number | undefined;
  let toolTimeoutSeconds: number | undefined;
  let geminiTimeoutMilliseconds: number | undefined;
  let force = false;

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
    const value = nextValue(args, index, flag);
    index += 1;
    switch (flag) {
      case "--repository":
        repositoryRoot = resolve(value);
        break;
      case "--upstreams":
        upstreamConfigPath = resolve(value);
        break;
      case "--output":
        outputDirectory = resolve(value);
        break;
      case "--server-entry":
        serverEntryPath = resolve(value);
        break;
      case "--node":
        nodeCommand = value;
        break;
      case "--name":
        serverName = value;
        break;
      case "--startup-timeout":
        startupTimeoutSeconds = positiveInteger(value, flag);
        break;
      case "--tool-timeout":
        toolTimeoutSeconds = positiveInteger(value, flag);
        break;
      case "--gemini-timeout":
        geminiTimeoutMilliseconds = positiveInteger(value, flag);
        break;
      default:
        throw new Error(`Unknown option ${flag}`);
    }
  }

  if (!upstreamConfigPath) throw new Error("--upstreams is required");
  return {
    repositoryRoot,
    upstreamConfigPath,
    outputDirectory: outputDirectory || resolve(repositoryRoot, ".morrow/client-configs"),
    ...(serverName ? { serverName } : {}),
    ...(nodeCommand ? { nodeCommand } : {}),
    ...(serverEntryPath ? { serverEntryPath } : {}),
    ...(startupTimeoutSeconds !== undefined ? { startupTimeoutSeconds } : {}),
    ...(toolTimeoutSeconds !== undefined ? { toolTimeoutSeconds } : {}),
    ...(geminiTimeoutMilliseconds !== undefined ? { geminiTimeoutMilliseconds } : {}),
    force,
  };
}

try {
  const options = parseArguments(process.argv.slice(2));
  const bundle = writeClientConfigBundle(options);
  process.stdout.write([
    `output=${options.outputDirectory}`,
    `server=${bundle.serverName}`,
    `transport=${bundle.transport}`,
    `files=${bundle.files.length}`,
    "",
  ].join("\n"));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[morrow-client-config] ${message}\n\n${usage()}`);
  process.exitCode = 1;
}
