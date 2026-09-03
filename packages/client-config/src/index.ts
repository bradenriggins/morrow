import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import { randomUUID } from "node:crypto";
import { sha256Text } from "@morrow/contracts";

export const SUPPORTED_MORROW_CLIENTS = Object.freeze([
  "codex",
  "claude-code",
  "gemini-cli",
] as const);
export type SupportedMorrowClient = typeof SUPPORTED_MORROW_CLIENTS[number];

export interface ClientConfigBundleOptions {
  readonly repositoryRoot: string;
  readonly upstreamConfigPath: string;
  readonly serverName?: string;
  readonly nodeCommand?: string;
  readonly serverEntryPath?: string;
  readonly startupTimeoutSeconds?: number;
  readonly toolTimeoutSeconds?: number;
  readonly geminiTimeoutMilliseconds?: number;
}

export interface ClientConfigFile {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
}

export interface ClientConfigBundle {
  readonly schema: "morrow.client-config-bundle.v1";
  readonly serverName: string;
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environmentNames: readonly ["MORROW_UPSTREAMS_FILE"];
  readonly files: readonly ClientConfigFile[];
}

export interface WriteClientConfigBundleOptions extends ClientConfigBundleOptions {
  readonly outputDirectory: string;
  readonly force?: boolean;
}

const SERVER_NAME = /^[a-z][a-z0-9_-]{0,62}$/;
const DEFAULT_SERVER_ENTRY = "packages/mcp-server/dist/index.js";

function exactServerName(value: string | undefined): string {
  const name = String(value || "morrow").trim().toLowerCase();
  if (!SERVER_NAME.test(name)) {
    throw new TypeError("serverName must use lowercase letters, numbers, underscores, or hyphens");
  }
  return name;
}

function exactAbsolutePath(value: string, label: string): string {
  const text = String(value || "").trim();
  if (!text || !isAbsolute(text)) {
    throw new TypeError(`${label} must be an absolute path`);
  }
  return resolve(text);
}

function exactCommand(value: string | undefined): string {
  const command = String(value || process.execPath).trim();
  if (!command || /[\r\n\0]/.test(command)) {
    throw new TypeError("nodeCommand is invalid");
  }
  return command;
}

function exactInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new TypeError(`${label} must be a whole number from ${minimum} through ${maximum}`);
  }
  return resolved;
}

function assertWithinRepository(repositoryRoot: string, path: string): void {
  const suffix = relative(repositoryRoot, path);
  if (suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix))) return;
  throw new TypeError("serverEntryPath must be inside repositoryRoot");
}

function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function posixQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function codexConfig(input: {
  serverName: string;
  command: string;
  serverEntryPath: string;
  repositoryRoot: string;
  upstreamConfigPath: string;
  startupTimeoutSeconds: number;
  toolTimeoutSeconds: number;
}): string {
  return [
    `[mcp_servers.${input.serverName}]`,
    `command = ${tomlString(input.command)}`,
    `args = ${tomlStringArray([input.serverEntryPath])}`,
    `cwd = ${tomlString(input.repositoryRoot)}`,
    `env = { MORROW_UPSTREAMS_FILE = ${tomlString(input.upstreamConfigPath)} }`,
    `startup_timeout_sec = ${input.startupTimeoutSeconds}`,
    `tool_timeout_sec = ${input.toolTimeoutSeconds}`,
    "required = true",
    'default_tools_approval_mode = "writes"',
    "",
  ].join("\n");
}

function claudeConfig(input: {
  serverName: string;
  command: string;
  serverEntryPath: string;
  repositoryRoot: string;
  upstreamConfigPath: string;
}): string {
  return jsonFile({
    mcpServers: {
      [input.serverName]: {
        type: "stdio",
        command: input.command,
        args: [input.serverEntryPath],
        cwd: input.repositoryRoot,
        env: {
          MORROW_UPSTREAMS_FILE: input.upstreamConfigPath,
        },
      },
    },
  });
}

function geminiConfig(input: {
  serverName: string;
  command: string;
  serverEntryPath: string;
  repositoryRoot: string;
  upstreamConfigPath: string;
  timeoutMilliseconds: number;
}): string {
  return jsonFile({
    mcpServers: {
      [input.serverName]: {
        command: input.command,
        args: [input.serverEntryPath],
        cwd: input.repositoryRoot,
        env: {
          MORROW_UPSTREAMS_FILE: input.upstreamConfigPath,
        },
        timeout: input.timeoutMilliseconds,
        trust: false,
      },
    },
  });
}

function installPosix(input: {
  serverName: string;
  command: string;
  serverEntryPath: string;
  upstreamConfigPath: string;
}): string {
  const environment = `MORROW_UPSTREAMS_FILE=${input.upstreamConfigPath}`;
  return [
    "#!/usr/bin/env sh",
    "set -eu",
    "",
    `codex mcp add ${posixQuote(input.serverName)} --env ${posixQuote(environment)} -- ${posixQuote(input.command)} ${posixQuote(input.serverEntryPath)}`,
    `claude mcp add ${posixQuote(input.serverName)} --scope user --env ${posixQuote(environment)} -- ${posixQuote(input.command)} ${posixQuote(input.serverEntryPath)}`,
    `gemini mcp add --scope user -e ${posixQuote(environment)} ${posixQuote(input.serverName)} ${posixQuote(input.command)} ${posixQuote(input.serverEntryPath)}`,
    "",
  ].join("\n");
}

function installPowerShell(input: {
  serverName: string;
  command: string;
  serverEntryPath: string;
  upstreamConfigPath: string;
}): string {
  const environment = `MORROW_UPSTREAMS_FILE=${input.upstreamConfigPath}`;
  return [
    "$ErrorActionPreference = 'Stop'",
    "",
    `codex mcp add ${powershellQuote(input.serverName)} --env ${powershellQuote(environment)} -- ${powershellQuote(input.command)} ${powershellQuote(input.serverEntryPath)}`,
    `claude mcp add ${powershellQuote(input.serverName)} --scope user --env ${powershellQuote(environment)} -- ${powershellQuote(input.command)} ${powershellQuote(input.serverEntryPath)}`,
    `gemini mcp add --scope user -e ${powershellQuote(environment)} ${powershellQuote(input.serverName)} ${powershellQuote(input.command)} ${powershellQuote(input.serverEntryPath)}`,
    "",
  ].join("\n");
}

function readme(input: {
  serverName: string;
  repositoryRoot: string;
  upstreamConfigPath: string;
}): string {
  return [
    `Morrow client bundle for ${input.serverName}`,
    "",
    "This directory contains local configuration snippets. It does not contain Canvas credentials, donor tokens, bridge tokens, or provider session data.",
    "",
    `Repository: ${input.repositoryRoot}`,
    `Upstream configuration: ${input.upstreamConfigPath}`,
    "",
    "Files:",
    "- codex.config.toml: merge into user or project Codex configuration.",
    "- claude.mcp.json: merge the mcpServers entry into Claude Code configuration.",
    "- gemini.settings.json: merge the mcpServers entry into Gemini CLI settings.",
    "- install.posix.sh and install.powershell.ps1: optional CLI registration commands.",
    "- verify.txt: client-neutral verification sequence.",
    "",
    "Do not commit this directory. Absolute local paths identify your machine.",
    "",
  ].join("\n");
}

function verificationText(serverName: string): string {
  return [
    `Verification sequence for ${serverName}`,
    "",
    "1. Build Morrow with pnpm build.",
    "2. Confirm the configured donor processes and the legacy bridge can start.",
    "3. Connect the client and call morrow_health.",
    "4. Confirm ready=true, expected source counts, source attestations, and catalog identity.",
    "5. Call morrow_catalog with a narrow query before choosing a tool.",
    "6. Run one read-only operation and inspect morrow_operation_get.",
    "7. For a write, confirm that the source reports a staged task rather than provider success.",
    "8. Approve only through the separate Morrow user interface.",
    "9. Use morrow_batch_reconcile or the source readback tool before stating provider success.",
    "10. Never repeat a write whose operation state is source_unknown or inspection_required.",
    "",
  ].join("\n");
}

function file(path: string, content: string): ClientConfigFile {
  return {
    path,
    content,
    sha256: sha256Text(content),
  };
}

export function buildClientConfigBundle(
  options: ClientConfigBundleOptions,
): ClientConfigBundle {
  const repositoryRoot = exactAbsolutePath(options.repositoryRoot, "repositoryRoot");
  const upstreamConfigPath = exactAbsolutePath(options.upstreamConfigPath, "upstreamConfigPath");
  const serverName = exactServerName(options.serverName);
  const command = exactCommand(options.nodeCommand);
  const serverEntryPath = options.serverEntryPath
    ? exactAbsolutePath(options.serverEntryPath, "serverEntryPath")
    : resolve(repositoryRoot, DEFAULT_SERVER_ENTRY);
  assertWithinRepository(repositoryRoot, serverEntryPath);
  const startupTimeoutSeconds = exactInteger(
    options.startupTimeoutSeconds,
    60,
    1,
    600,
    "startupTimeoutSeconds",
  );
  const toolTimeoutSeconds = exactInteger(
    options.toolTimeoutSeconds,
    900,
    1,
    3600,
    "toolTimeoutSeconds",
  );
  const geminiTimeoutMilliseconds = exactInteger(
    options.geminiTimeoutMilliseconds,
    toolTimeoutSeconds * 1000,
    1_000,
    3_600_000,
    "geminiTimeoutMilliseconds",
  );

  const shared = {
    serverName,
    command,
    serverEntryPath,
    repositoryRoot,
    upstreamConfigPath,
  };
  const baseFiles = [
    file("codex.config.toml", codexConfig({
      ...shared,
      startupTimeoutSeconds,
      toolTimeoutSeconds,
    })),
    file("claude.mcp.json", claudeConfig(shared)),
    file("gemini.settings.json", geminiConfig({
      ...shared,
      timeoutMilliseconds: geminiTimeoutMilliseconds,
    })),
    file("install.posix.sh", installPosix(shared)),
    file("install.powershell.ps1", installPowerShell(shared)),
    file("README.txt", readme(shared)),
    file("verify.txt", verificationText(serverName)),
  ];
  const manifestContent = jsonFile({
    schema: "morrow.client-config-manifest.v1",
    serverName,
    transport: "stdio",
    command,
    args: [serverEntryPath],
    cwd: repositoryRoot,
    environmentNames: ["MORROW_UPSTREAMS_FILE"],
    files: baseFiles.map((entry) => ({
      path: entry.path,
      sha256: entry.sha256,
    })),
  });
  const files = [...baseFiles, file("manifest.json", manifestContent)]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

  return {
    schema: "morrow.client-config-bundle.v1",
    serverName,
    transport: "stdio",
    command,
    args: [serverEntryPath],
    cwd: repositoryRoot,
    environmentNames: ["MORROW_UPSTREAMS_FILE"],
    files,
  };
}

function assertRegularFile(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} does not exist as a regular file: ${path}`);
  }
}

function safeChmod(path: string, mode: number): void {
  try { chmodSync(path, mode); } catch { /* best effort on non-POSIX filesystems */ }
}

export function writeClientConfigBundle(
  options: WriteClientConfigBundleOptions,
): ClientConfigBundle {
  const outputDirectory = exactAbsolutePath(options.outputDirectory, "outputDirectory");
  const bundle = buildClientConfigBundle(options);
  assertRegularFile(bundle.args[0]!, "Morrow server entry");
  assertRegularFile(exactAbsolutePath(options.upstreamConfigPath, "upstreamConfigPath"), "Upstream configuration");
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  safeChmod(outputDirectory, 0o700);

  for (const entry of bundle.files) {
    const destination = resolve(outputDirectory, entry.path);
    if (existsSync(destination) && options.force !== true) {
      throw new Error(`Refusing to overwrite ${destination} without force=true`);
    }
  }

  for (const entry of bundle.files) {
    const destination = resolve(outputDirectory, entry.path);
    const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(temporary, entry.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    safeChmod(temporary, 0o600);
    renameSync(temporary, destination);
    safeChmod(destination, entry.path === "install.posix.sh" ? 0o700 : 0o600);
  }
  return bundle;
}
