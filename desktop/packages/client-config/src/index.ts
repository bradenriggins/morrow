import {
  readSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import {
  isAbsolute,
  dirname,
  join,
  relative,
  resolve,
  win32,
} from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { sha256Text } from "@morrow/contracts";

export const SUPPORTED_MORROW_CLIENTS = Object.freeze([
  "codex",
  "claude-code",
  "claude-desktop",
  "gemini-cli",
  "cursor",
  "vscode",
] as const);
export type SupportedMorrowClient = typeof SUPPORTED_MORROW_CLIENTS[number];
export const MORROW_CLIENT_SCOPES = Object.freeze(["project", "user"] as const);
export type MorrowClientScope = typeof MORROW_CLIENT_SCOPES[number];

export const MORROW_CLIENT_REFUSAL_CODES = Object.freeze([
  "client_scope_unsupported",
  "client_platform_unsupported",
  "client_configuration_location_unknown",
] as const);
export type MorrowClientRefusalCode = typeof MORROW_CLIENT_REFUSAL_CODES[number];

/**
 * A configuration location Morrow will not guess. The message is the reason and then the next
 * action, so command output tells a person what to do instead of reporting a type error.
 */
export class MorrowClientConfigRefusal extends Error {
  readonly schema = "morrow.client-config-refusal.v1";
  readonly code: MorrowClientRefusalCode;
  readonly client: SupportedMorrowClient;
  readonly scope: MorrowClientScope;
  readonly platform: string;
  readonly reason: string;
  readonly nextAction: string;

  constructor(input: {
    readonly code: MorrowClientRefusalCode;
    readonly client: SupportedMorrowClient;
    readonly scope: MorrowClientScope;
    readonly platform: string;
    readonly reason: string;
    readonly nextAction: string;
  }) {
    super(`${input.reason} ${input.nextAction}`);
    this.name = "MorrowClientConfigRefusal";
    this.code = input.code;
    this.client = input.client;
    this.scope = input.scope;
    this.platform = input.platform;
    this.reason = input.reason;
    this.nextAction = input.nextAction;
  }
}

export const MORROW_CLIENT_WRITE_REFUSAL_CODES = Object.freeze([
  "config_invalid",
  "config_unreadable",
  "config_read_only",
  "config_permission_denied",
  "config_symlink",
  "config_busy",
  "config_existing_entry",
  "config_entry_not_morrow",
  "config_changed",
] as const);
export type MorrowClientWriteRefusalCode = typeof MORROW_CLIENT_WRITE_REFUSAL_CODES[number];

/**
 * A client configuration file Morrow would not change, with the reason as a code and the exact
 * file. The installer shows its own words for each code, so the message stays technical.
 */
export class MorrowClientConfigWriteRefusal extends Error {
  readonly schema = "morrow.client-config-error.v1";
  readonly code: MorrowClientWriteRefusalCode;
  readonly path: string;

  constructor(code: MorrowClientWriteRefusalCode, path: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MorrowClientConfigWriteRefusal";
    this.code = code;
    this.path = path;
  }
}

function writeRefusal(code: MorrowClientWriteRefusalCode, path: string, message: string, cause?: unknown): MorrowClientConfigWriteRefusal {
  return new MorrowClientConfigWriteRefusal(code, path, message, cause);
}

/**
 * Whether one parsed server entry is one Morrow wrote. Every client shape Morrow writes passes
 * the upstream configuration through MORROW_UPSTREAMS_FILE, and no other server uses that name.
 */
export function isMorrowServerEntry(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const env = (value as Record<string, unknown>).env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return false;
  const upstreams = (env as Record<string, unknown>).MORROW_UPSTREAMS_FILE;
  return typeof upstreams === "string" && upstreams.length > 0;
}

export interface MorrowEntryRemovalOptions {
  /** Refuse, instead of removing, a server of that name that does not carry Morrow's marker. */
  readonly requireMorrowEntry?: boolean;
}

export interface ClientConfigBundleOptions {
  readonly repositoryRoot: string;
  readonly upstreamConfigPath: string;
  /** The assistant project allowed to supply local files. Defaults to repositoryRoot. */
  readonly workspaceRoot?: string;
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
  /** How each written file is restricted. Defaults to this computer's platform. */
  readonly restriction?: PrivateFileRestriction;
}

export interface InstallMorrowClientOptions extends ClientConfigBundleOptions {
  readonly client: SupportedMorrowClient;
  readonly scope?: MorrowClientScope;
  readonly projectRoot?: string;
  /** Replace the client file only when its complete bytes still match this recorded digest. */
  readonly expectedConfigSha256?: string;
  /** Replace an existing server of this name when it carries Morrow's marker, whatever else changed. */
  readonly replaceMorrowEntry?: boolean;
}

export interface InstalledMorrowClient {
  readonly client: SupportedMorrowClient;
  readonly scope: MorrowClientScope;
  readonly path: string;
  readonly changed: boolean;
  /** Digest read back from the complete client configuration after installation. */
  readonly sha256: string;
}

export interface MorrowClientConfigurationStatus {
  readonly path: string;
  readonly configured: boolean;
  /** Digest of the complete current file when it could be read safely. */
  readonly sha256: string | null;
}

export interface LocalCanvasConfiguration {
  readonly path: string;
  readonly extensionPath: string;
  readonly stateDirectory: string;
  readonly changed: boolean;
}

export interface ClientParityReport {
  readonly schema: "morrow.client-parity-report.v1";
  readonly proofLevel: "hermetic_config_only";
  readonly realClientExecution: "not_run";
  readonly scenarios: readonly string[];
  readonly clients: readonly {
    readonly client: SupportedMorrowClient;
    readonly command: string;
    readonly args: readonly string[];
    /** Present only when the client's documented schema can pin the working directory. */
    readonly cwd?: string;
    readonly workingDirectory: "pinned" | "client_default";
    readonly environmentNames: readonly string[];
    readonly equivalent: boolean;
  }[];
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
  if (!isAbsolute(command)) throw new TypeError("nodeCommand must be an absolute path");
  return resolve(command);
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

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
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
  workspaceRoot: string;
  upstreamConfigPath: string;
  startupTimeoutSeconds: number;
  toolTimeoutSeconds: number;
}): string {
  return [
    `[mcp_servers.${input.serverName}]`,
    `command = ${tomlString(input.command)}`,
    `args = ${tomlStringArray([input.serverEntryPath])}`,
    `cwd = ${tomlString(input.workspaceRoot)}`,
    `env = { MORROW_UPSTREAMS_FILE = ${tomlString(input.upstreamConfigPath)} }`,
    `startup_timeout_sec = ${input.startupTimeoutSeconds}`,
    `tool_timeout_sec = ${input.toolTimeoutSeconds}`,
    'default_tools_approval_mode = "writes"',
    "",
  ].join("\n");
}

function claudeConfig(input: {
  serverName: string;
  command: string;
  serverEntryPath: string;
  workspaceRoot: string;
  upstreamConfigPath: string;
}): string {
  return jsonFile({
    mcpServers: {
      [input.serverName]: {
        type: "stdio",
        command: input.command,
        args: [input.serverEntryPath],
        cwd: input.workspaceRoot,
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
  workspaceRoot: string;
  upstreamConfigPath: string;
  timeoutMilliseconds: number;
}): string {
  return jsonFile({
    mcpServers: {
      [input.serverName]: {
        command: input.command,
        args: [input.serverEntryPath],
        cwd: input.workspaceRoot,
        env: {
          MORROW_UPSTREAMS_FILE: input.upstreamConfigPath,
        },
        timeout: input.timeoutMilliseconds,
        trust: false,
      },
    },
  });
}

// Cursor reads an "mcpServers" map from .cursor/mcp.json in a project and ~/.cursor/mcp.json in the
// home directory. Its documented stdio fields are type, command, args, env and envFile. There is no
// documented cwd field, so Morrow runs in the directory Cursor starts it in and that directory
// becomes the assistant workspace.
// Source: https://cursor.com/docs/mcp, read 6 September 2026.
function cursorConfig(input: {
  serverName: string;
  command: string;
  serverEntryPath: string;
  upstreamConfigPath: string;
}): string {
  return jsonFile({
    mcpServers: {
      [input.serverName]: {
        type: "stdio",
        command: input.command,
        args: [input.serverEntryPath],
        env: {
          MORROW_UPSTREAMS_FILE: input.upstreamConfigPath,
        },
      },
    },
  });
}

// VS Code reads a "servers" map from .vscode/mcp.json in a workspace. Its documented stdio fields
// include type, command, args, cwd and env. The user-profile mcp.json has no documented filesystem
// path; VS Code opens that file through the MCP: Open User Configuration command.
// Source: https://code.visualstudio.com/docs/agents/reference/mcp-configuration, read 6 September 2026.
function vsCodeConfig(input: {
  serverName: string;
  command: string;
  serverEntryPath: string;
  workspaceRoot: string;
  upstreamConfigPath: string;
}): string {
  return jsonFile({
    servers: {
      [input.serverName]: {
        type: "stdio",
        command: input.command,
        args: [input.serverEntryPath],
        cwd: input.workspaceRoot,
        env: {
          MORROW_UPSTREAMS_FILE: input.upstreamConfigPath,
        },
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
    "# Use `morrow mcp install <client> --scope project` for safe project configuration writes.",
    "# ChatGPT, the Codex CLI, and the Codex IDE extension read ~/.codex/config.toml, which is what codex mcp add writes.",
    "# For ChatGPT, use `morrow mcp install codex --scope user`. A project .codex/config.toml loads only in a project you have marked trusted.",
    `claude mcp add ${posixQuote(input.serverName)} --scope project --env ${posixQuote(environment)} -- ${posixQuote(input.command)} ${posixQuote(input.serverEntryPath)}`,
    `gemini mcp add --scope project -e ${posixQuote(environment)} ${posixQuote(input.serverName)} ${posixQuote(input.command)} ${posixQuote(input.serverEntryPath)}`,
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
    "# Use `morrow mcp install <client> --scope project` for safe project configuration writes.",
    "# ChatGPT, the Codex CLI, and the Codex IDE extension read ~/.codex/config.toml, which is what codex mcp add writes.",
    "# For ChatGPT, use `morrow mcp install codex --scope user`. A project .codex/config.toml loads only in a project you have marked trusted.",
    `claude mcp add ${powershellQuote(input.serverName)} --scope project --env ${powershellQuote(environment)} -- ${powershellQuote(input.command)} ${powershellQuote(input.serverEntryPath)}`,
    `gemini mcp add --scope project -e ${powershellQuote(environment)} ${powershellQuote(input.serverName)} ${powershellQuote(input.command)} ${powershellQuote(input.serverEntryPath)}`,
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
    "This directory contains local configuration snippets. It does not contain Canvas credentials, connector tokens, cookies, or provider session data.",
    "",
    `Repository: ${input.repositoryRoot}`,
    `Upstream configuration: ${input.upstreamConfigPath}`,
    "",
    "Files:",
    "- codex.config.toml: merge into ~/.codex/config.toml. ChatGPT, the Codex CLI, and the Codex IDE extension read that file. A project .codex/config.toml loads only in a project you have marked trusted.",
    "- claude.mcp.json: merge the mcpServers entry into Claude Code configuration.",
    "- claude-desktop.config.json: merge the mcpServers entry into claude_desktop_config.json. That file is in Library/Application Support/Claude on macOS and in %APPDATA%\\Claude on Windows. Claude Desktop opens it from Settings, Developer, Edit Config.",
    "- gemini.settings.json: merge the mcpServers entry into Gemini CLI settings.",
    "- cursor.mcp.json: merge the mcpServers entry into .cursor/mcp.json or ~/.cursor/mcp.json. Cursor documents no cwd field, so Morrow uses the directory Cursor starts it in. Open Cursor on a project folder. Morrow refuses to run with a disk root or your home directory as the workspace.",
    "- vscode.mcp.json: merge the servers entry into .vscode/mcp.json. For a user profile, run MCP: Open User Configuration in VS Code and merge it there.",
    "- install.posix.sh and install.powershell.ps1: project-scope registration commands for Claude Code and Gemini CLI. Use morrow mcp install for all supported clients.",
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
    "2. Install the Morrow Bridge extension and pair it with the local MCP.",
    "3. Open one signed-in Canvas or Moodle course in Chrome and connect that exact course in the extension popup.",
    "4. Connect your assistant and call morrow_health.",
    "5. Confirm ready=true, the connector is connected, and the catalog identity matches.",
    "6. Call morrow_catalog with a narrow query before choosing a tool.",
    "7. Run one read-only operation.",
    "8. For a write, inspect the frozen plan and open its local approval URL.",
    "9. Approve on the separate loopback approval page in Chrome with Morrow Bridge connected. A request sent to that page by another program cannot approve.",
    "10. The approval page starts the change once. Require connector-owned fresh readback before stating success.",
    "11. Never repeat a write whose operation state is source_unknown or inspection_required.",
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
  const workspaceRoot = options.workspaceRoot === undefined
    ? repositoryRoot
    : exactAbsolutePath(options.workspaceRoot, "workspaceRoot");
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
    workspaceRoot,
    upstreamConfigPath,
  };
  const baseFiles = [
    file("codex.config.toml", codexConfig({
      ...shared,
      startupTimeoutSeconds,
      toolTimeoutSeconds,
    })),
    file("claude.mcp.json", claudeConfig(shared)),
    file("claude-desktop.config.json", claudeConfig(shared)),
    file("gemini.settings.json", geminiConfig({
      ...shared,
      timeoutMilliseconds: geminiTimeoutMilliseconds,
    })),
    file("cursor.mcp.json", cursorConfig(shared)),
    file("vscode.mcp.json", vsCodeConfig(shared)),
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
    cwd: workspaceRoot,
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
    cwd: workspaceRoot,
    environmentNames: ["MORROW_UPSTREAMS_FILE"],
    files,
  };
}

function assertRegularFile(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} does not exist as a regular file: ${path}`);
  }
}

function assertDirectory(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`${label} does not exist as a directory: ${path}`);
  }
}

function canonicalDirectory(path: string, label: string): string {
  const absolute = exactAbsolutePath(path, label);
  assertDirectory(absolute, label);
  return realpathSync(absolute);
}

function canonicalRegularFile(path: string, label: string): string {
  const absolute = exactAbsolutePath(path, label);
  assertRegularFile(absolute, label);
  return realpathSync(absolute);
}

function exactExecutable(path: string, label: string): string {
  const absolute = exactAbsolutePath(path, label);
  const canonical = canonicalRegularFile(absolute, label);
  if (process.platform !== "win32") {
    if ((statSync(canonical).mode & 0o111) === 0) {
      throw new Error(`${label} is not executable: ${path}`);
    }
  } else {
    // Windows mode bits are synthetic: a non-PE file passes every permission
    // check and fails later with a message that names no file. The first two
    // bytes are checked here instead.
    const magic = Buffer.alloc(2);
    const handle = openSync(canonical, "r");
    try { readSync(handle, magic, 0, 2, 0); } finally { closeSync(handle); }
    if (magic.toString("ascii", 0, 2) !== "MZ") {
      throw new Error(`${label} is not a Windows executable: ${path}`);
    }
  }
  return canonical;
}

function assertNoSymlinkPath(root: string, path: string): void {
  const boundary = exactAbsolutePath(root, "client configuration root");
  const target = exactAbsolutePath(path, "client configuration path");
  const suffix = relative(boundary, target);
  if (suffix.startsWith("..") || isAbsolute(suffix)) {
    throw new Error(`Refusing to write ${target} outside ${boundary}`);
  }
  for (let current = target; ; current = dirname(current)) {
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw writeRefusal("config_symlink", target, `Refusing to write ${target} because ${current} is a symbolic link`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current === boundary) break;
  }
}

function safeChmod(path: string, mode: number): void {
  try { chmodSync(path, mode); } catch { /* best effort on non-POSIX filesystems */ }
}

function privatePosixFileAccepted(path: string): boolean {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) return false;
    return typeof process.getuid !== "function" || info.uid === process.getuid();
  } catch {
    return false;
  }
}

function macAclIsPrivate(output: string): boolean {
  const mode = output.match(/^(\S+)/)?.[1];
  return Boolean(mode) && !mode!.includes("+") && !/\n\s*\d+:\s/u.test(output);
}

/**
 * SYSTEM and the local Administrators group. Windows treats these two as
 * present on every private path, so Morrow's own release gate counts a path
 * private when nothing but them and the signed-in account has sensitive
 * access. `smokeWindowsAclClassification` in installer/main.cjs reads exactly
 * this rule, so a file restricted here is a file that gate calls private.
 */
const PRIVATE_WINDOWS_SIDS = Object.freeze(["S-1-5-18", "S-1-5-32-544"]);
const RESTRICTED = "restricted";

export interface PrivateFileRestrictionResult {
  readonly status: number | null;
  readonly stdout?: string;
  readonly error?: Error;
}

export type PrivateFileRestrictionRunner = (
  command: string,
  args: readonly string[],
) => PrivateFileRestrictionResult;

/**
 * How one private file is restricted. Both fields exist so the Windows path can
 * be exercised where Windows is not: no computer running these tests can create
 * a Windows access-control list, but every decision Morrow makes around one is
 * still its own code and is still testable.
 */
export interface PrivateFileRestriction {
  readonly platform?: string;
  readonly run?: PrivateFileRestrictionRunner;
}

function defaultRestrictionRunner(command: string, args: readonly string[]): PrivateFileRestrictionResult {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", error: result.error ?? undefined };
}

/**
 * The Windows command that restricts one file to the signed-in account. The
 * path travels as base64 UTF-16, so no quoting rule in any shell can change
 * which file is restricted. The list is replaced rather than added to, and
 * inheritance is turned off, so a project directory that other accounts can
 * read cannot pass that access on to the file Morrow wrote inside it.
 */
export function windowsPrivateFileCommand(path: string): { readonly command: string; readonly args: readonly string[] } {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const encodedPath = Buffer.from(path, "utf16le").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    `$target = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    "if (-not [IO.File]::Exists($target)) { throw 'Private file is unavailable' }",
    "$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$acl = New-Object Security.AccessControl.FileSecurity",
    "$acl.SetAccessRuleProtection($true, $false)",
    `foreach ($sid in @($identity.Value, ${PRIVATE_WINDOWS_SIDS.map((sid) => `'${sid}'`).join(", ")})) { $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)), 'FullControl', 'None', 'None', 'Allow'))) }`,
    "[IO.File]::SetAccessControl($target, $acl)",
    `'${RESTRICTED}'`,
  ].join("; ");
  return {
    command: win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
  };
}

/**
 * Restricts one file to the account running Morrow.
 *
 * POSIX files receive and verify an account-only mode. macOS files also have
 * every extended ACL removed and the resulting ACL inspected. Windows ignores
 * mode bits, so it receives a replacement ACL for this account, SYSTEM, and
 * Administrators with inheritance disabled.
 *
 * It throws when the restriction cannot be applied. Every caller applies it to
 * a still-empty temporary file, before that file holds anything and before it
 * replaces anything, so a refusal here leaves no Morrow-written content on the
 * computer at all.
 */
export function restrictToCurrentAccount(path: string, restriction?: PrivateFileRestriction, posixMode = 0o600): void {
  const platform = restriction?.platform ?? process.platform;
  const run = restriction?.run ?? defaultRestrictionRunner;
  if (platform !== "win32") {
    try {
      chmodSync(path, posixMode);
    } catch (error) {
      throw new Error(`Refusing to use ${path} because Morrow could not make it private: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (platform === "darwin") {
      let removed: PrivateFileRestrictionResult;
      let inspected: PrivateFileRestrictionResult;
      try {
        removed = run("/bin/chmod", ["-N", path]);
        inspected = run("/bin/ls", ["-lde", path]);
      } catch (error) {
        throw new Error(`Refusing to use ${path} because Morrow could not remove and verify its macOS access-control list: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (removed.error || removed.status !== 0 || inspected.error || inspected.status !== 0
        || !macAclIsPrivate(String(inspected.stdout ?? ""))) {
        throw new Error(`Refusing to use ${path} because Morrow could not remove and verify its macOS access-control list`);
      }
    }
    if (!privatePosixFileAccepted(path)) {
      throw new Error(`Refusing to use ${path} because it is not a private regular file owned by this account`);
    }
    return;
  }
  const { command, args } = windowsPrivateFileCommand(path);
  let result: PrivateFileRestrictionResult;
  try {
    result = run(command, args);
  } catch (error) {
    throw new Error(`Refusing to write ${path} because Morrow could not restrict it to this Windows account: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.error || result.status !== 0 || String(result.stdout ?? "").trim() !== RESTRICTED) {
    throw new Error(`Refusing to write ${path} because Morrow could not restrict it to this Windows account`);
  }
}

function sameExactFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameExactSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  // ctime can gain precision after a fresh write without any file mutation.
  return sameExactFile(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.gid === right.gid;
}

function unlinkExactFile(path: string, expected: BigIntStats): void {
  try {
    const current = lstatSync(path, { bigint: true });
    if (sameExactFile(current, expected)) unlinkSync(path);
  } catch { /* preserve the primary failure */ }
}

function syncExactDirectory(path: string): void {
  if (process.platform === "win32") return;
  const named = lstatSync(path, { bigint: true });
  if (!named.isDirectory() || named.isSymbolicLink()) throw new Error(`${path} is not one exact directory`);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(handle, { bigint: true });
    if (!opened.isDirectory() || !sameExactFile(named, opened)) throw new Error(`${path} changed before its directory flush`);
    fsyncSync(handle);
    const after = fstatSync(handle, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    if (!sameExactSnapshot(opened, after) || !sameExactSnapshot(after, current)) {
      throw new Error(`${path} changed during its directory flush`);
    }
  } finally {
    closeSync(handle);
  }
}

/**
 * Creates one file that no other account can read, then fills it. The file is
 * created empty and restricted before a single byte of content reaches it, so
 * a computer that cannot apply the restriction never holds an unprotected copy
 * of what Morrow was about to write.
 */
function writeRestrictedFile(path: string, content: string, mode: number, restriction?: PrivateFileRestriction): BigIntStats {
  const handle = openSync(path, "wx", mode);
  let closed = false;
  let created = fstatSync(handle, { bigint: true });
  try {
    const named = lstatSync(path, { bigint: true });
    if (!created.isFile() || created.nlink !== 1n || !sameExactFile(created, named) || named.nlink !== 1n) {
      throw new Error(`${path} changed during private-file creation`);
    }
    restrictToCurrentAccount(path, restriction, mode);
    const restricted = fstatSync(handle, { bigint: true });
    const restrictedName = lstatSync(path, { bigint: true });
    if (!sameExactFile(created, restricted) || !sameExactSnapshot(restricted, restrictedName)
      || restricted.nlink !== 1n) {
      throw new Error(`${path} changed during private-file preparation`);
    }
    writeFileSync(handle, content, "utf8");
    fsyncSync(handle);
    const written = fstatSync(handle, { bigint: true });
    const writtenName = lstatSync(path, { bigint: true });
    if (!sameExactSnapshot(written, writtenName) || written.nlink !== 1n
      || written.size !== BigInt(Buffer.byteLength(content, "utf8"))) {
      throw new Error(`${path} changed while private content was written`);
    }
    created = written;
    if ((restriction?.platform ?? process.platform) !== "win32"
      && (Number(written.mode) & 0o777) !== mode) {
      throw new Error(`Refusing to use ${path} because its private mode could not be verified`);
    }
    return written;
  } catch (error) {
    closeSync(handle);
    closed = true;
    unlinkExactFile(path, created);
    throw error;
  } finally {
    if (!closed) closeSync(handle);
  }
}

interface ExpectedFileText {
  readonly exists: boolean;
  readonly content: string;
  readonly identity?: BigIntStats;
  readonly mode?: number;
}

// An assistant configuration file is a hand-edited JSON or TOML document. Four
// MiB is far above any real one, so a file past this bound is not a
// configuration any more: reading it whole would be the one unbounded read on
// this surface, so it is refused instead.
const MAX_CLIENT_CONFIG_BYTES = 4 * 1024 * 1024;

function currentFileText(path: string, requirePrivate = false): ExpectedFileText {
  const invalid = (): Error => writeRefusal(
    "config_unreadable",
    path,
    `Refusing to replace ${path} because it is not a regular file under 4 MiB with stable single-link identity`,
  );
  let named: BigIntStats;
  try {
    named = lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, content: "" };
    throw invalid();
  }
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n
    || named.size > BigInt(MAX_CLIENT_CONFIG_BYTES)
    || (typeof process.getuid === "function" && named.uid !== BigInt(process.getuid()))) {
    throw invalid();
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const nonblocking = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
  let handle: number | undefined;
  try {
    handle = openSync(path, constants.O_RDONLY | noFollow | nonblocking);
    const opened = fstatSync(handle, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameExactSnapshot(named, opened)
      || opened.size > BigInt(MAX_CLIENT_CONFIG_BYTES)
      || (requirePrivate && process.platform !== "win32" && (Number(opened.mode) & 0o077) !== 0)) {
      throw invalid();
    }
    const bytes = Buffer.allocUnsafe(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(handle, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(handle, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    if (offset !== bytes.length || !sameExactSnapshot(opened, after)
      || !sameExactSnapshot(after, current) || current.nlink !== 1n) {
      throw invalid();
    }
    let content: string;
    // A byte-order mark is kept, so a rewrite leaves the file's own encoding marker in place.
    try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw invalid(); }
    return { exists: true, content, identity: after, mode: Number(after.mode) & 0o7777 };
  } catch (error) {
    if (error instanceof Error && error.message === invalid().message) throw error;
    throw invalid();
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function sameFileText(left: ExpectedFileText, right: ExpectedFileText): boolean {
  if (!left.exists || !right.exists) return left.exists === right.exists;
  return left.content === right.content && left.identity !== undefined && right.identity !== undefined
    && sameExactSnapshot(left.identity, right.identity);
}

const PERMISSION_ERRORS = new Set(["EACCES", "EPERM", "EROFS"]);

function writePrivateText(
  path: string,
  content: string,
  expected?: ExpectedFileText,
  restriction?: PrivateFileRestriction,
  finalMode?: number,
): void {
  try {
    writePrivateTextOnce(path, content, expected, restriction, finalMode);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string" && PERMISSION_ERRORS.has(code)) {
      throw writeRefusal("config_permission_denied", path, `Refusing to write ${path} because this account may not change it or its folder`, error);
    }
    throw error;
  }
}

function writePrivateTextOnce(
  path: string,
  content: string,
  expected: ExpectedFileText | undefined,
  restriction: PrivateFileRestriction | undefined,
  finalMode: number | undefined,
): void {
  const parent = dirname(path);
  const created = mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (created !== undefined) safeChmod(parent, 0o700);
  if (expected && !sameFileText(currentFileText(path), expected)) {
    throw writeRefusal("config_changed", path, `Refusing to replace ${path} because it changed during installation`);
  }
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let prepared: BigIntStats | undefined;
  const posix = (restriction?.platform ?? process.platform) !== "win32";
  try {
    prepared = writeRestrictedFile(temporary, content, 0o600, restriction);
    // An existing file keeps the mode its owner gave it. Only a file Morrow creates is private.
    if (finalMode !== undefined && posix && finalMode !== 0o600) chmodSync(temporary, finalMode);
    if (expected && !sameFileText(currentFileText(path), expected)) {
      throw writeRefusal("config_changed", path, `Refusing to replace ${path} because it changed during installation`);
    }
    // The rename carries the file, and on Windows its restricted access list,
    // onto the final path. A file that could not be restricted never gets here.
    try {
      renameSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EBUSY") {
        throw writeRefusal("config_busy", path, `Refusing to replace ${path} because the assistant that uses it is running and holds it open. Close the assistant, then run the same command again.`, error);
      }
      throw error;
    }
    const installed = currentFileText(path, finalMode === undefined);
    if (!installed.exists || installed.identity === undefined || !sameExactFile(prepared, installed.identity)
      || installed.content !== content) {
      throw new Error(`Morrow could not confirm the exact configuration written to ${path}`);
    }
    syncExactDirectory(parent);
  } finally {
    if (prepared !== undefined) unlinkExactFile(temporary, prepared);
  }
}

/**
 * Writes one local file the way Morrow writes every configuration file it owns:
 * private to this account, replaced in one step, and refused outright when it
 * cannot be made private. Exported so the refusal can be exercised for a
 * platform this computer is not.
 */
export function writePrivateLocalFile(
  pathValue: string,
  content: string,
  restriction?: PrivateFileRestriction,
): void {
  writePrivateText(exactAbsolutePath(pathValue, "path"), content, undefined, restriction);
}

export function buildLocalCanvasConfig(
  repositoryRootValue: string,
  nodeCommandValue: string = process.execPath,
  stateDirectoryValue?: string,
): Record<string, unknown> {
  const repositoryRoot = exactAbsolutePath(repositoryRootValue, "repositoryRoot");
  const nodeCommand = exactCommand(nodeCommandValue);
  const stateDirectory = stateDirectoryValue === undefined
    ? resolve(repositoryRoot, ".morrow")
    : exactAbsolutePath(stateDirectoryValue, "stateDirectory");
  return {
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    toolSurface: "compact",
    upstreams: [{
      id: "canvas-session",
      label: "Morrow Bridge",
      kind: "mcp-stdio",
      command: nodeCommand,
      args: [resolve(repositoryRoot, "packages/canvas-connector-mcp/dist/index.js")],
      cwd: repositoryRoot,
      env: {
        MORROW_CANVAS_CATALOG_PATH: resolve(repositoryRoot, "artifacts/canvas-api/canvas-api-catalog.json"),
        MORROW_CANVAS_CONNECTOR_STATE: resolve(stateDirectory, "canvas-connector.json"),
      },
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
    operationJournal: { path: resolve(stateDirectory, "morrow.sqlite3") },
    batchScheduler: { maxConcurrentReadWindows: 2 },
    privacy: {
      canvasOrigin: "browser-session",
      account: "local-browser-account",
      principal: "local-browser-principal",
      learnerVaultPath: resolve(stateDirectory, "learner-vault.json"),
    },
    maxCatalogTools: 2_000,
  };
}

export function writeLocalCanvasConfig(input: {
  readonly repositoryRoot: string;
  readonly path?: string;
  readonly nodeCommand?: string;
  /** Existing durable directory for keys, journal, connector state, and learner vault. */
  readonly stateDirectory?: string;
  readonly force?: boolean;
  /** Replace only an unchanged local settings file produced by this generator. */
  readonly replaceGenerated?: boolean;
}): LocalCanvasConfiguration {
  const repositoryRoot = exactAbsolutePath(input.repositoryRoot, "repositoryRoot");
  const path = input.path ? exactAbsolutePath(input.path, "configuration path") : resolve(repositoryRoot, "morrow.upstreams.json");
  const stateDirectory = input.stateDirectory === undefined
    ? resolve(repositoryRoot, ".morrow")
    : canonicalDirectory(input.stateDirectory, "stateDirectory");
  const extensionPath = resolve(repositoryRoot, "connector/extension");
  for (const [candidate, label] of [
    [resolve(repositoryRoot, "packages/mcp-server/dist/index.js"), "Morrow MCP server"],
    [resolve(repositoryRoot, "packages/canvas-connector-mcp/dist/index.js"), "Canvas connector MCP"],
    [resolve(repositoryRoot, "artifacts/canvas-api/canvas-api-catalog.json"), "Canvas API catalog"],
    [resolve(extensionPath, "manifest.json"), "Chrome connector extension"],
  ] as const) assertRegularFile(candidate, label);
  const content = jsonFile(buildLocalCanvasConfig(repositoryRoot, input.nodeCommand, stateDirectory));
  const current = currentFileText(path);
  if (current.exists) {
    if (current.content === content) return { path, extensionPath, stateDirectory, changed: false };
    let generated = false;
    if (input.replaceGenerated === true) {
      try {
        const parsed = JSON.parse(current.content) as Record<string, unknown>;
        const upstreams = Array.isArray(parsed?.upstreams) ? parsed.upstreams : [];
        const upstream = upstreams.length === 1 && upstreams[0] && typeof upstreams[0] === "object" && !Array.isArray(upstreams[0])
          ? upstreams[0] as Record<string, unknown>
          : null;
        generated = typeof upstream?.cwd === "string" && typeof upstream.command === "string"
          && isDeepStrictEqual(parsed, buildLocalCanvasConfig(upstream.cwd, upstream.command, stateDirectory));
      } catch {
        generated = false;
      }
    }
    if (input.force !== true && !generated) throw new Error(`Refusing to replace existing Morrow configuration at ${path}`);
  }
  writePrivateText(path, content, current);
  return { path, extensionPath, stateDirectory, changed: true };
}

function exactScope(scope: MorrowClientScope | undefined): MorrowClientScope {
  const value = scope || "project";
  if (!(MORROW_CLIENT_SCOPES as readonly string[]).includes(value)) {
    throw new TypeError("scope must be project or user");
  }
  return value;
}

function exactClient(client: SupportedMorrowClient): SupportedMorrowClient {
  if (!(SUPPORTED_MORROW_CLIENTS as readonly string[]).includes(client)) {
    throw new TypeError(`client must be one of ${SUPPORTED_MORROW_CLIENTS.join(", ")}`);
  }
  return client;
}

export interface MorrowClientConfigLocation {
  readonly client: SupportedMorrowClient;
  readonly scope?: MorrowClientScope;
  /** The project directory. Used only by project scope. */
  readonly projectRoot?: string;
  /** The signed-in person's home directory. Defaults to this account's home directory. */
  readonly homeDirectory?: string;
  /** Defaults to this computer's platform. */
  readonly platform?: string;
  /** Windows %APPDATA%. Defaults to the APPDATA environment variable. */
  readonly applicationDataDirectory?: string;
}

/**
 * The file Morrow writes for one assistant and scope, or a refusal that names the reason and the
 * next action. Every location here is a documented one; Morrow does not guess a path.
 */
export function morrowClientConfigPath(input: MorrowClientConfigLocation): string {
  const client = exactClient(input.client);
  const scope = exactScope(input.scope);
  const platform = input.platform || process.platform;
  const root = () => scope === "project"
    ? exactAbsolutePath(input.projectRoot || "", "projectRoot")
    : exactAbsolutePath(input.homeDirectory || homedir(), "homeDirectory");
  switch (client) {
    // ChatGPT, the Codex CLI, and the Codex IDE extension share one MCP configuration file, and
    // `codex mcp add` writes the user one at ~/.codex/config.toml. A project layer
    // <project>/.codex/config.toml is documented too, but Codex loads it only for a project the
    // person has marked trusted, and the ChatGPT desktop application is reported to load only the
    // user file (openai/codex issue 13025, open on 6 September 2026). Morrow's ChatGPT route is
    // therefore user scope; project scope stays available for the Codex CLI in a trusted project.
    // Sources: https://learn.chatgpt.com/docs/extend/mcp and
    // https://learn.chatgpt.com/docs/config-file/config-basic, both read 6 September 2026.
    case "codex": return join(root(), ".codex", "config.toml");
    case "claude-code": return scope === "project" ? join(root(), ".mcp.json") : join(root(), ".claude.json");
    case "claude-desktop": {
      if (scope !== "user") {
        throw new MorrowClientConfigRefusal({
          code: "client_scope_unsupported",
          client,
          scope,
          platform,
          reason: "Claude Desktop reads one configuration file for the signed-in person, so it has no project configuration.",
          nextAction: "Run the same command with --scope user.",
        });
      }
      // Claude Desktop documents claude_desktop_config.json at
      // ~/Library/Application Support/Claude on macOS and %APPDATA%\Claude on Windows. Both are the
      // file Claude Desktop opens from Settings, Developer, Edit Config.
      // Source: https://modelcontextprotocol.io/docs/develop/connect-local-servers, read 6 September 2026.
      if (platform === "darwin") {
        return join(root(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
      }
      if (platform === "win32") {
        // Live-unverified: the documented Windows location. No Windows computer has confirmed a
        // Morrow write here. The write itself uses the same merge, readback, and refusal contract
        // as macOS.
        const applicationData = String(input.applicationDataDirectory ?? process.env.APPDATA ?? "").trim();
        if (!applicationData || !win32.isAbsolute(applicationData)) {
          throw new MorrowClientConfigRefusal({
            code: "client_configuration_location_unknown",
            client,
            scope,
            platform,
            reason: "Morrow could not read the Windows application data folder (APPDATA) that holds claude_desktop_config.json.",
            nextAction: "In Claude Desktop, open Settings, Developer, Edit Config, then merge the entry from claude-desktop.config.json.",
          });
        }
        return win32.join(applicationData, "Claude", "claude_desktop_config.json");
      }
      throw new MorrowClientConfigRefusal({
        code: "client_platform_unsupported",
        client,
        scope,
        platform,
        reason: `Claude Desktop documents a configuration file for macOS and Windows only, and this computer reports ${platform}.`,
        nextAction: "On this computer, set up Claude Code, ChatGPT, Gemini CLI, Cursor, or VS Code instead.",
      });
    }
    case "gemini-cli": return join(root(), ".gemini", "settings.json");
    case "cursor": return join(root(), ".cursor", "mcp.json");
    case "vscode": {
      if (scope !== "project") {
        throw new MorrowClientConfigRefusal({
          code: "client_configuration_location_unknown",
          client,
          scope,
          platform,
          reason: "VS Code stores user-profile MCP servers in a file with no documented path.",
          nextAction: "Run MCP: Open User Configuration in VS Code, then merge the entry from vscode.mcp.json.",
        });
      }
      return join(root(), ".vscode", "mcp.json");
    }
  }
}

/**
 * What a person still needs to know about the exact file Morrow just wrote. Empty when the
 * location needs no explanation.
 */
export function morrowClientConfigNotes(input: {
  readonly client: SupportedMorrowClient;
  readonly scope: MorrowClientScope;
  readonly platform?: string;
}): readonly string[] {
  const platform = input.platform || process.platform;
  if (input.client === "codex" && input.scope === "project") {
    return ["Codex reads a project .codex/config.toml only in a project you have marked trusted. The ChatGPT desktop app reads the user file, so for ChatGPT run this command again with --scope user."];
  }
  if (input.client === "claude-desktop" && platform === "win32") {
    return ["This is the documented Windows location, and no Windows computer has confirmed a Morrow write here. In Claude Desktop, open Settings, Developer, Edit Config, and check that Morrow is listed."];
  }
  return [];
}

interface ClientJsonShape {
  readonly file: string;
  readonly container: string;
}

const CLIENT_JSON: Readonly<Record<Exclude<SupportedMorrowClient, "codex">, ClientJsonShape>> = Object.freeze({
  "claude-code": { file: "claude.mcp.json", container: "mcpServers" },
  "claude-desktop": { file: "claude-desktop.config.json", container: "mcpServers" },
  "gemini-cli": { file: "gemini.settings.json", container: "mcpServers" },
  cursor: { file: "cursor.mcp.json", container: "mcpServers" },
  vscode: { file: "vscode.mcp.json", container: "servers" },
});

function serverEntry(
  bundle: ClientConfigBundle,
  client: SupportedMorrowClient,
  upstreamConfigPath?: string,
): Record<string, unknown> {
  if (client === "codex") {
    if (!bundle.files.some((entry) => entry.path === "codex.config.toml")) {
      throw new Error("Morrow did not generate codex.config.toml");
    }
    return {
      command: bundle.command,
      args: [...bundle.args],
      cwd: bundle.cwd,
      env: { MORROW_UPSTREAMS_FILE: exactAbsolutePath(upstreamConfigPath || "", "upstreamConfigPath") },
    };
  }
  const { file: name, container } = CLIENT_JSON[client];
  const content = bundle.files.find((entry) => entry.path === name)?.content;
  if (!content) throw new Error(`Morrow did not generate ${name}`);
  const parsed = jsonObject(JSON.parse(content), name);
  return jsonObject(jsonObject(parsed[container], `${name}.${container}`)[bundle.serverName], `${name}.${bundle.serverName}`);
}

function codexSection(bundle: ClientConfigBundle): string {
  const fragment = bundle.files.find((entry) => entry.path === "codex.config.toml")?.content;
  if (!fragment) throw new Error("Morrow did not generate the Codex configuration");
  return fragment;
}

/** An empty file, or one holding only whitespace and a byte-order mark, has no settings yet. */
function blankClientJson(content: string): boolean {
  return content.replace(/^\uFEFF/u, "").trim() === "";
}

function parseClientJson(path: string, content: string): Record<string, unknown> {
  if (blankClientJson(content)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsoncForJsonParse(content));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw writeRefusal("config_invalid", path, `Refusing to replace ${path} because it is not valid JSON: ${detail}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw writeRefusal("config_invalid", path, `Refusing to replace ${path} because it must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** The server map of one client document. A missing or null map is an empty one. */
function clientJsonServers(path: string, document: Record<string, unknown>, container: string): Record<string, unknown> {
  const servers = document[container];
  if (servers === undefined || servers === null) return {};
  if (typeof servers !== "object" || Array.isArray(servers)) {
    throw writeRefusal("config_invalid", path, `Refusing to replace ${path} because ${container} must contain a JSON object`);
  }
  return servers as Record<string, unknown>;
}

/**
 * Converts the comment-bearing JSON accepted by editor configuration files to
 * strict JSON without moving any later source offset. Keeping offsets stable is
 * what lets the structural editor below preserve every unrelated byte.
 */
function jsoncForJsonParse(content: string): string {
  const prepared = content.split("");
  if (prepared[0] === "\uFEFF") prepared[0] = " ";
  let inString = false;
  for (let index = 0; index < content.length; index += 1) {
    const current = content[index]!;
    if (inString) {
      if (current === "\\") index += 1;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      continue;
    }
    if (current !== "/" || (content[index + 1] !== "/" && content[index + 1] !== "*")) continue;
    const lineComment = content[index + 1] === "/";
    prepared[index] = " ";
    prepared[index + 1] = " ";
    index += 2;
    if (lineComment) {
      while (index < content.length && content[index] !== "\n" && content[index] !== "\r") {
        prepared[index] = " ";
        index += 1;
      }
      index -= 1;
      continue;
    }
    let closed = false;
    while (index < content.length) {
      if (content[index] === "*" && content[index + 1] === "/") {
        prepared[index] = " ";
        prepared[index + 1] = " ";
        index += 1;
        closed = true;
        break;
      }
      if (content[index] !== "\n" && content[index] !== "\r") prepared[index] = " ";
      index += 1;
    }
    if (!closed) throw new Error("unterminated block comment");
  }
  const tokens = tokenizeJson(content);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.text === "," && (tokens[index + 1]?.text === "}" || tokens[index + 1]?.text === "]")) {
      prepared[token.start] = " ";
    }
  }
  return prepared.join("");
}

interface JsonToken {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

interface JsonObjectMember {
  readonly key: string;
  readonly keyStart: number;
  readonly keyEnd: number;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly commaStart?: number;
  readonly commaEnd?: number;
}

interface JsonObjectText {
  readonly openEnd: number;
  readonly closeStart: number;
  readonly members: readonly JsonObjectMember[];
  readonly trailingComma: boolean;
}

function tokenizeJson(content: string): readonly JsonToken[] {
  const tokens: JsonToken[] = [];
  for (let index = 0; index < content.length;) {
    if (/\s/.test(content[index]!)) {
      index += 1;
      continue;
    }
    if (content[index] === "/" && content[index + 1] === "/") {
      index += 2;
      while (index < content.length && content[index] !== "\n" && content[index] !== "\r") index += 1;
      continue;
    }
    if (content[index] === "/" && content[index + 1] === "*") {
      index += 2;
      while (index < content.length && !(content[index] === "*" && content[index + 1] === "/")) index += 1;
      if (index >= content.length) throw new Error("valid JSON had an unterminated block comment");
      index += 2;
      continue;
    }
    const start = index;
    if (content[index] === '"') {
      index += 1;
      while (index < content.length) {
        if (content[index] === "\\") {
          index += 2;
          continue;
        }
        index += 1;
        if (content[index - 1] === '"') break;
      }
    } else if ("{}[],:".includes(content[index]!)) {
      index += 1;
    } else {
      while (index < content.length && !/\s/.test(content[index]!) && !"{}[],:".includes(content[index]!)) {
        index += 1;
      }
    }
    tokens.push({ text: content.slice(start, index), start, end: index });
  }
  return tokens;
}

function afterJsonValue(tokens: readonly JsonToken[], start: number): number {
  const opening = tokens[start]?.text;
  if (opening !== "{" && opening !== "[") return start + 1;
  const stack = [opening];
  for (let index = start + 1; index < tokens.length; index += 1) {
    const token = tokens[index]!.text;
    if (token === "{" || token === "[") stack.push(token);
    if (token === "}" || token === "]") {
      const expected = token === "}" ? "{" : "[";
      if (stack.pop() !== expected) throw new Error("valid JSON had an inconsistent container");
      if (stack.length === 0) return index + 1;
    }
  }
  throw new Error("valid JSON had an unterminated container");
}

function jsonObjectText(
  content: string,
  tokens: readonly JsonToken[],
  openIndex: number,
  label: string,
): JsonObjectText {
  if (tokens[openIndex]?.text !== "{") throw new Error(`${label} must contain a JSON object`);
  const members: JsonObjectMember[] = [];
  let trailingComma = false;
  let index = openIndex + 1;
  while (tokens[index]?.text !== "}") {
    const key = tokens[index];
    if (!key || !key.text.startsWith('"') || tokens[index + 1]?.text !== ":") {
      throw new Error(`${label} must contain a JSON object`);
    }
    const valueIndex = index + 2;
    const afterValue = afterJsonValue(tokens, valueIndex);
    const member: {
      key: string;
      keyStart: number;
      keyEnd: number;
      valueStart: number;
      valueEnd: number;
      commaStart?: number;
      commaEnd?: number;
    } = {
      key: JSON.parse(key.text) as string,
      keyStart: key.start,
      keyEnd: key.end,
      valueStart: tokens[valueIndex]!.start,
      valueEnd: tokens[afterValue - 1]!.end,
    };
    index = afterValue;
    if (tokens[index]?.text === ",") {
      member.commaStart = tokens[index]!.start;
      member.commaEnd = tokens[index]!.end;
      index += 1;
      trailingComma = tokens[index]?.text === "}";
    }
    else if (tokens[index]?.text !== "}") throw new Error(`${label} must contain a JSON object`);
    members.push(member);
  }
  return {
    openEnd: tokens[openIndex]!.end,
    closeStart: tokens[index]!.start,
    members,
    trailingComma,
  };
}

function oneJsonMember(object: JsonObjectText, key: string, label: string): JsonObjectMember | undefined {
  const matches = object.members.filter((member) => member.key === key);
  if (matches.length > 1) throw new Error(`Refusing to edit ${label} because ${key} appears more than once`);
  return matches[0];
}

function lineIndent(content: string, offset: number): string {
  const lineStart = content.lastIndexOf("\n", offset - 1) + 1;
  return content.slice(lineStart, offset).match(/^[\t ]*/)?.[0] || "";
}

function jsonIndentUnit(content: string, object: JsonObjectText): string {
  const closingIndent = lineIndent(content, object.closeStart);
  for (const member of object.members) {
    const memberIndent = lineIndent(content, member.keyStart);
    if (memberIndent.startsWith(closingIndent) && memberIndent.length > closingIndent.length) {
      return memberIndent.slice(closingIndent.length);
    }
  }
  return closingIndent.includes("\t") ? "\t" : "  ";
}

function jsonColon(content: string, object: JsonObjectText): string {
  const member = object.members[0];
  if (!member) return ": ";
  const separator = content.slice(member.keyEnd, member.valueStart);
  return separator.includes(":") ? separator : ": ";
}

function formattedJsonValue(
  value: unknown,
  multiline: boolean,
  propertyIndent: string,
  indentUnit: string,
  lineEnding: string,
): string {
  if (!multiline) return JSON.stringify(value);
  return JSON.stringify(value, null, indentUnit).split("\n").join(`${lineEnding}${propertyIndent}`);
}

function addJsonMember(
  content: string,
  object: JsonObjectText,
  key: string,
  value: unknown,
): string {
  const interior = content.slice(object.openEnd, object.closeStart);
  const multiline = interior.includes("\n");
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const indentUnit = jsonIndentUnit(content, object);
  const propertyIndent = object.members[0]
    ? lineIndent(content, object.members[0]!.keyStart)
    : `${lineIndent(content, object.closeStart)}${indentUnit}`;
  const property = `${JSON.stringify(key)}${jsonColon(content, object)}${formattedJsonValue(value, multiline, propertyIndent, indentUnit, lineEnding)}`;
  let insertion = object.closeStart;
  while (insertion > object.openEnd && /\s/.test(content[insertion - 1]!)) insertion -= 1;
  const prefix = object.members.length === 0
    ? multiline ? `${lineEnding}${propertyIndent}` : ""
    : object.trailingComma
      ? multiline ? `${lineEnding}${propertyIndent}` : " "
      : multiline ? `,${lineEnding}${propertyIndent}` : ", ";
  return `${content.slice(0, insertion)}${prefix}${property}${content.slice(insertion)}`;
}

function replaceJsonMemberValue(
  content: string,
  object: JsonObjectText,
  member: JsonObjectMember,
  value: unknown,
): string {
  const multiline = content.slice(object.openEnd, object.closeStart).includes("\n");
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const propertyIndent = lineIndent(content, member.keyStart);
  const replacement = formattedJsonValue(value, multiline, propertyIndent, jsonIndentUnit(content, object), lineEnding);
  return `${content.slice(0, member.valueStart)}${replacement}${content.slice(member.valueEnd)}`;
}

function removeJsonMember(content: string, object: JsonObjectText, member: JsonObjectMember): string {
  const memberIndex = object.members.indexOf(member);
  if (memberIndex < 0) throw new Error("JSON member is not part of its container");
  const ranges = [{ start: member.keyStart, end: member.valueEnd }];
  if (member.commaStart !== undefined && member.commaEnd !== undefined) {
    ranges.push({ start: member.commaStart, end: member.commaEnd });
  } else if (memberIndex > 0) {
    const previous = object.members[memberIndex - 1]!;
    if (previous.commaStart === undefined || previous.commaEnd === undefined) {
      throw new Error("JSON member has no removable separator");
    }
    ranges.push({ start: previous.commaStart, end: previous.commaEnd });
  }
  return ranges.sort((left, right) => right.start - left.start).reduce(
    (updated, range) => `${updated.slice(0, range.start)}${updated.slice(range.end)}`,
    content,
  );
}

/**
 * Removes one semantic server member from a JSON or JSONC client document.
 * Only the member tokens and one adjacent comma are removed. Every other byte,
 * including comments, line endings, whitespace, and numeric spelling, stays
 * byte-exact and in the same order.
 */
export function withoutMorrowClientJson(
  content: string,
  container = "mcpServers",
  serverName = "morrow",
  options: MorrowEntryRemovalOptions = {},
): string | null {
  const label = "assistant configuration";
  const parsed = parseClientJson(label, content);
  if (blankClientJson(content)) return null;
  const tokens = tokenizeJson(content);
  const document = jsonObjectText(content, tokens, 0, label);
  const containerMember = oneJsonMember(document, container, label);
  if (!containerMember) {
    if (Object.hasOwn(parsed, container)) throw new Error(`Refusing to remove ${serverName} from ${label}`);
    return null;
  }
  const parsedServers = clientJsonServers(label, parsed, container);
  if (parsed[container] === null) return null;
  const containerOpen = tokens.findIndex((token) => token.start === containerMember.valueStart);
  const servers = jsonObjectText(content, tokens, containerOpen, `${label}.${container}`);
  const server = oneJsonMember(servers, serverName, `${label}.${container}`);
  if (!server) {
    if (Object.hasOwn(parsedServers, serverName)) throw new Error(`Refusing to remove ${serverName} from ${label}`);
    return null;
  }
  if (options.requireMorrowEntry === true && !isMorrowServerEntry(parsedServers[serverName])) {
    throw writeRefusal("config_entry_not_morrow", label, `Refusing to remove ${serverName} from ${label} because it was not written by Morrow`);
  }

  const updated = removeJsonMember(content, servers, server);
  const checked = parseClientJson(label, updated);
  const checkedServers = clientJsonServers(label, checked, container);
  if (Object.hasOwn(checkedServers, serverName)) {
    throw new Error(`Refusing to remove ${serverName} from ${label}`);
  }
  return updated;
}

function editClientJson(
  path: string,
  content: string,
  container: string,
  serverName: string,
  entry: Record<string, unknown>,
  replace: boolean,
): string {
  const tokens = tokenizeJson(content);
  const document = jsonObjectText(content, tokens, 0, path);
  const containerMember = oneJsonMember(document, container, path);
  if (!containerMember) return addJsonMember(content, document, container, { [serverName]: entry });
  const containerOpen = tokens.findIndex((token) => token.start === containerMember.valueStart);
  if (tokens[containerOpen]?.text === "null") {
    return replaceJsonMemberValue(content, document, containerMember, { [serverName]: entry });
  }
  const servers = jsonObjectText(content, tokens, containerOpen, `${path}.${container}`);
  const server = oneJsonMember(servers, serverName, `${path}.${container}`);
  if (!server) return addJsonMember(content, servers, serverName, entry);
  if (!replace) throw writeRefusal("config_existing_entry", path, `Refusing to replace existing Morrow server ${serverName} in ${path}`);
  return replaceJsonMemberValue(content, servers, server, entry);
}

function exactExpectedConfigSha256(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError("expectedConfigSha256 must be a lowercase SHA-256 digest");
  }
  return value;
}

function assertExpectedClientConfig(
  path: string,
  current: ExpectedFileText,
  expectedConfigSha256: string | undefined,
): void {
  if (expectedConfigSha256 === undefined) return;
  if (!current.exists || sha256Text(current.content) !== expectedConfigSha256) {
    throw writeRefusal("config_changed", path, `Refusing to replace ${path} because it changed after Morrow recorded it`);
  }
}

interface ClientEntryWrite {
  readonly expectedConfigSha256?: string;
  readonly replaceMorrowEntry?: boolean;
}

/**
 * Whether an existing, different server of Morrow's name may be replaced. A recorded whole-file
 * digest still admits it; otherwise the entry itself must carry Morrow's marker.
 */
function assertReplaceableEntry(path: string, serverName: string, existing: unknown, write: ClientEntryWrite): void {
  if (write.expectedConfigSha256 !== undefined) return;
  if (write.replaceMorrowEntry === true) {
    if (isMorrowServerEntry(existing)) return;
    throw writeRefusal("config_entry_not_morrow", path, `Refusing to replace existing Morrow server ${serverName} in ${path} because it was not written by Morrow`);
  }
  throw writeRefusal("config_existing_entry", path, `Refusing to replace existing Morrow server ${serverName} in ${path}`);
}

/**
 * The mode an existing client file keeps when Morrow rewrites it. Group and other accounts lose
 * write access, because the file names a program the assistant runs. A read-only file is refused.
 */
function preservedClientMode(path: string, current: ExpectedFileText): number | undefined {
  if (!current.exists || current.mode === undefined) return undefined;
  if ((current.mode & 0o200) === 0) {
    throw writeRefusal("config_read_only", path, `Refusing to change ${path} because it is read-only`);
  }
  return current.mode & 0o755;
}

/** The unchanged-file path: nothing is written, and only write access for other accounts is removed. */
function tightenUnchangedClientFile(path: string, current: ExpectedFileText): void {
  if (process.platform === "win32" || current.mode === undefined || (current.mode & 0o022) === 0) return;
  safeChmod(path, current.mode & 0o755);
}

function installJsonEntry(
  path: string,
  container: string,
  serverName: string,
  entry: Record<string, unknown>,
  write: ClientEntryWrite,
): boolean {
  const current = currentFileText(path);
  assertExpectedClientConfig(path, current, write.expectedConfigSha256);
  const document = current.exists
    ? parseClientJson(path, current.content)
    : {};
  const servers = clientJsonServers(path, document, container);
  const existing = servers[serverName];
  if (existing !== undefined) {
    if (isDeepStrictEqual(existing, entry)) {
      tightenUnchangedClientFile(path, current);
      return false;
    }
    assertReplaceableEntry(path, serverName, existing, write);
  }
  const mode = preservedClientMode(path, current);
  const content = current.exists && !blankClientJson(current.content)
    ? editClientJson(path, current.content, container, serverName, entry, existing !== undefined)
    : jsonFile({ [container]: { [serverName]: entry } });
  const checked = parseClientJson(path, content);
  const checkedServers = clientJsonServers(path, checked, container);
  if (!isDeepStrictEqual(checkedServers[serverName], entry)) {
    throw new Error(`Refusing to write ${path} because the prepared Morrow entry is invalid`);
  }
  writePrivateText(path, content, current, undefined, mode);
  return true;
}

function tomlObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a TOML table`);
  }
  return value as Record<string, unknown>;
}

/** The TOML parser builds null-prototype tables; Morrow compares them with ordinary objects. */
function ordinaryTomlValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordinaryTomlValue);
  if (value && typeof value === "object" && (Object.getPrototypeOf(value) === null || Object.getPrototypeOf(value) === Object.prototype)) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, ordinaryTomlValue(nested)]));
  }
  return value;
}

function parseCodexToml(path: string, content: string): Record<string, unknown> {
  try {
    return tomlObject(ordinaryTomlValue(parseToml(content.replace(/^\uFEFF/u, ""))), path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw writeRefusal("config_invalid", path, `Refusing to replace ${path} because it is not valid TOML: ${detail}`);
  }
}

function codexMcpServer(document: Record<string, unknown>, serverName: string, path: string): unknown {
  const servers = document.mcp_servers;
  if (servers === undefined) return undefined;
  return tomlObject(servers, `${path}.mcp_servers`)[serverName];
}

/**
 * The part of a Codex server entry Morrow owns. Codex keeps per-tool approvals under
 * [mcp_servers.<name>.tools.*]; those belong to the person and do not make the entry different.
 */
function codexEntryWithoutTools(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { tools: _tools, ...rest } = value as Record<string, unknown>;
  return rest;
}

function sameCodexEntry(actual: unknown, expected: unknown): boolean {
  return isDeepStrictEqual(codexEntryWithoutTools(actual), expected);
}

function tomlHeaderPath(line: string): readonly string[] | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("[")) return null;
  const arrayHeader = trimmed.startsWith("[[");
  const marker = "__morrow_header_marker__";
  let parsed: Record<string, unknown>;
  try {
    parsed = tomlObject(parseToml(`${line.replace(/^\uFEFF/u, "")}\n${marker} = true\n`), "TOML header");
  } catch {
    return null;
  }
  const paths: string[][] = [];
  const visit = (value: unknown, path: string[]): void => {
    if (Array.isArray(value) && arrayHeader) {
      for (const item of value) visit(item, path);
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key === marker && nested === true) paths.push(path);
      else visit(nested, [...path, key]);
    }
  };
  visit(parsed, []);
  return paths.length === 1 ? paths[0]! : null;
}

interface TomlLine {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly header: readonly string[] | null;
}

function tomlLines(content: string): readonly TomlLine[] {
  const lines: TomlLine[] = [];
  let offset = 0;
  for (const line of content.match(/[^\n]*(?:\n|$)/g) || []) {
    if (line.length === 0) continue;
    const text = line.endsWith("\n") ? line.slice(0, -1) : line;
    lines.push({ start: offset, end: offset + line.length, text, header: tomlHeaderPath(text) });
    offset += line.length;
  }
  return lines;
}

function morrowHeader(header: readonly string[] | null, serverName: string): boolean {
  return header !== null && header.length >= 2 && header[0] === "mcp_servers" && header[1] === serverName;
}

function blankOrComment(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

/**
 * The byte range of one table section, from its header to the next header. A closing run of
 * blank and comment lines that holds a comment belongs to the table that follows it.
 */
function sectionRanges(lines: readonly TomlLine[], contentLength: number): readonly { readonly index: number; readonly start: number; readonly end: number; readonly bodyEnd: number }[] {
  const headers = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.header !== null);
  return headers.map(({ line, index }, position) => {
    const nextIndex = position + 1 < headers.length ? headers[position + 1]!.index : lines.length;
    const end = nextIndex < lines.length ? lines[nextIndex]!.start : contentLength;
    let tail = nextIndex;
    while (tail - 1 > index && blankOrComment(lines[tail - 1]!.text)) tail -= 1;
    const trailing = lines.slice(tail, nextIndex);
    const firstComment = trailing.findIndex((entry) => entry.text.trim().startsWith("#"));
    const bodyEnd = firstComment === -1 ? end : trailing[firstComment]!.start;
    return { index, start: line.start, end, bodyEnd };
  });
}

function withoutCodexServer(document: Record<string, unknown>, serverName: string, reference: Record<string, unknown>): Record<string, unknown> {
  const servers = { ...(document.mcp_servers as Record<string, unknown>) };
  delete servers[serverName];
  const { mcp_servers: _servers, ...rest } = document;
  return Object.keys(servers).length === 0 && reference.mcp_servers === undefined ? rest : { ...rest, mcp_servers: servers };
}

/**
 * Removes Morrow's Codex server: its table and every [mcp_servers.<name>.*] subtable, wherever
 * each one is. The TOML parser decides key identity, so bare, quoted, and escaped spellings of
 * `morrow` cannot leave a live server behind. Every other byte stays as it was, and the result
 * must parse to the same document without that server, or nothing is returned.
 */
export function withoutMorrowCodexTable(
  content: string,
  serverName = "morrow",
  options: MorrowEntryRemovalOptions = {},
): string | null {
  const path = "Codex configuration";
  const document = parseCodexToml(path, content);
  const existing = codexMcpServer(document, serverName, path);
  if (existing === undefined) return null;
  if (options.requireMorrowEntry === true && !isMorrowServerEntry(existing)) {
    throw writeRefusal("config_entry_not_morrow", path, `Refusing to remove ${serverName} from ${path} because it was not written by Morrow`);
  }
  const refusal = () => new Error(`Refusing to remove Morrow from ${path} without rewriting existing TOML`);
  const lines = tomlLines(content);
  const removed = sectionRanges(lines, content.length)
    .filter((section) => morrowHeader(lines[section.index]!.header, serverName));
  if (!removed.some((section) => lines[section.index]!.header!.length === 2)) throw refusal();
  let updated = "";
  let cursor = 0;
  for (const section of removed) {
    updated += content.slice(cursor, section.start);
    cursor = section.bodyEnd;
  }
  updated += content.slice(cursor);
  if (cursor === content.length) {
    const kept = updated.trimEnd();
    updated = kept.length === 0 ? "" : `${kept}\n`;
  }
  let checked: Record<string, unknown>;
  try {
    checked = parseCodexToml(path, updated);
  } catch {
    throw refusal();
  }
  if (!isDeepStrictEqual(checked, withoutCodexServer(document, serverName, checked))) throw refusal();
  return updated;
}

function appendCodexSection(content: string, section: string): string {
  if (content.length === 0) return section;
  const separator = content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${separator}${section}`;
}

/**
 * Replaces the body of Morrow's own [mcp_servers.<name>] table and nothing else. Subtables,
 * later tables, and a closing comment block stay byte-exact.
 */
function replaceMorrowCodexSection(
  path: string,
  content: string,
  serverName: string,
  section: string,
): string {
  const lines = tomlLines(content);
  const main = sectionRanges(lines, content.length).filter((candidate) => {
    const header = lines[candidate.index]!.header;
    return header !== null && header.length === 2 && morrowHeader(header, serverName) && !lines[candidate.index]!.text.trimStart().startsWith("[[");
  });
  if (main.length !== 1) {
    throw new Error(`Refusing to replace Morrow in ${path} without rewriting existing TOML`);
  }
  const range = main[0]!;
  let end = range.bodyEnd;
  // Blank lines between Morrow's table and the next one stay, so the spacing a person chose is kept.
  while (end > range.start && content[end - 1] === "\n" && content[end - 2] === "\n") end -= 1;
  return `${content.slice(0, range.start)}${section}${content.slice(end)}`;
}

function installCodexEntry(
  path: string,
  serverName: string,
  section: string,
  write: ClientEntryWrite,
): boolean {
  const current = currentFileText(path);
  assertExpectedClientConfig(path, current, write.expectedConfigSha256);
  const document = parseCodexToml(path, current.content);
  const expected = codexMcpServer(parseCodexToml(path, section), serverName, path);
  const existing = codexMcpServer(document, serverName, path);
  if (existing !== undefined) {
    if (sameCodexEntry(existing, expected)) {
      tightenUnchangedClientFile(path, current);
      return false;
    }
    assertReplaceableEntry(path, serverName, existing, write);
  }
  const mode = preservedClientMode(path, current);
  const content = existing === undefined
    ? appendCodexSection(current.content, section)
    : replaceMorrowCodexSection(path, current.content, serverName, section);
  let prepared: Record<string, unknown>;
  try {
    prepared = parseCodexToml(path, content);
  } catch {
    throw new Error(`Refusing to add Morrow to ${path} without rewriting existing TOML`);
  }
  if (!sameCodexEntry(codexMcpServer(prepared, serverName, path), expected)) {
    throw new Error(`Refusing to replace Morrow in ${path} without rewriting existing TOML`);
  }
  writePrivateText(path, content, current, undefined, mode);
  return true;
}

function installedClientDigest(
  path: string,
  client: SupportedMorrowClient,
  container: string | undefined,
  serverName: string,
  expected: Record<string, unknown>,
): string {
  const current = currentFileText(path);
  if (!current.exists) throw new Error(`Morrow could not confirm its configuration in ${path}`);
  const content = current.content;
  const confirmed = client === "codex"
    ? sameCodexEntry(codexMcpServer(parseCodexToml(path, content), serverName, path), expected)
    : isDeepStrictEqual(clientJsonServers(path, parseClientJson(path, content), container!)[serverName], expected);
  if (!confirmed) {
    throw new Error(`Morrow could not confirm its configuration in ${path}`);
  }
  return sha256Text(content);
}

/**
 * Reads one supported client configuration without changing it and verifies
 * the exact Morrow server entry. Unrelated client settings do not affect the
 * result. The complete-file digest remains available for later guarded writes.
 */
export function morrowClientConfigurationStatus(
  options: InstallMorrowClientOptions,
): MorrowClientConfigurationStatus {
  const client = exactClient(options.client);
  const scope = exactScope(options.scope);
  const repositoryRoot = exactAbsolutePath(options.repositoryRoot, "repositoryRoot");
  const canonicalRepositoryRoot = canonicalDirectory(repositoryRoot, "repositoryRoot");
  if (scope === "user" && options.projectRoot !== undefined) {
    throw new TypeError("projectRoot is supported only for project-scoped client configuration");
  }
  const configurationRoot = scope === "project"
    ? canonicalDirectory(options.projectRoot || repositoryRoot, "projectRoot")
    : canonicalRepositoryRoot;
  const workspaceRoot = options.workspaceRoot === undefined
    ? configurationRoot
    : canonicalDirectory(options.workspaceRoot, "workspaceRoot");
  const command = exactExecutable(options.nodeCommand || process.execPath, "nodeCommand");
  const serverEntryPath = exactAbsolutePath(
    options.serverEntryPath || resolve(repositoryRoot, DEFAULT_SERVER_ENTRY),
    "Morrow server entry",
  );
  const canonicalServerEntryPath = canonicalRegularFile(serverEntryPath, "Morrow server entry");
  assertWithinRepository(canonicalRepositoryRoot, canonicalServerEntryPath);
  const canonicalUpstreamConfigPath = canonicalRegularFile(options.upstreamConfigPath, "Upstream configuration");
  const bundle = buildClientConfigBundle({
    ...options,
    repositoryRoot: canonicalRepositoryRoot,
    workspaceRoot,
    nodeCommand: command,
    serverEntryPath: canonicalServerEntryPath,
    upstreamConfigPath: canonicalUpstreamConfigPath,
  });
  const homeDirectory = exactAbsolutePath(homedir(), "homeDirectory");
  const path = morrowClientConfigPath({ client, scope, projectRoot: configurationRoot, homeDirectory });
  const clientConfigurationRoot = scope === "project"
    ? configurationRoot
    : client === "claude-desktop" && process.platform === "win32"
      ? dirname(dirname(path))
      : homeDirectory;
  assertNoSymlinkPath(clientConfigurationRoot, path);
  const current = currentFileText(path);
  if (!current.exists) return { path, configured: false, sha256: null };
  const expected = client === "codex"
    ? tomlObject(
      codexMcpServer(parseCodexToml(path, codexSection(bundle)), bundle.serverName, path),
      `${path}.mcp_servers.${bundle.serverName}`,
    )
    : serverEntry(bundle, client, canonicalUpstreamConfigPath);
  const configured = client === "codex"
    ? sameCodexEntry(codexMcpServer(parseCodexToml(path, current.content), bundle.serverName, path), expected)
    : isDeepStrictEqual(clientJsonServers(path, parseClientJson(path, current.content), CLIENT_JSON[client].container)[bundle.serverName], expected);
  return {
    path,
    configured,
    sha256: sha256Text(current.content),
  };
}

export function installMorrowClient(options: InstallMorrowClientOptions): InstalledMorrowClient {
  const client = exactClient(options.client);
  const scope = exactScope(options.scope);
  const repositoryRoot = exactAbsolutePath(options.repositoryRoot, "repositoryRoot");
  const canonicalRepositoryRoot = canonicalDirectory(repositoryRoot, "repositoryRoot");
  const expectedConfigSha256 = exactExpectedConfigSha256(options.expectedConfigSha256);
  if (scope === "user" && options.projectRoot !== undefined) {
    throw new TypeError("projectRoot is supported only for project-scoped client configuration");
  }
  const configurationRoot = scope === "project"
    ? canonicalDirectory(options.projectRoot || repositoryRoot, "projectRoot")
    : canonicalRepositoryRoot;
  const workspaceRoot = options.workspaceRoot === undefined
    ? configurationRoot
    : canonicalDirectory(options.workspaceRoot, "workspaceRoot");
  const command = exactExecutable(options.nodeCommand || process.execPath, "nodeCommand");
  const serverEntryPath = exactAbsolutePath(
    options.serverEntryPath || resolve(repositoryRoot, DEFAULT_SERVER_ENTRY),
    "Morrow server entry",
  );
  const canonicalServerEntryPath = canonicalRegularFile(serverEntryPath, "Morrow server entry");
  assertWithinRepository(canonicalRepositoryRoot, canonicalServerEntryPath);
  const canonicalUpstreamConfigPath = canonicalRegularFile(options.upstreamConfigPath, "Upstream configuration");
  const bundle = buildClientConfigBundle({
    ...options,
    repositoryRoot: canonicalRepositoryRoot,
    workspaceRoot,
    nodeCommand: command,
    serverEntryPath: canonicalServerEntryPath,
    upstreamConfigPath: canonicalUpstreamConfigPath,
  });
  const homeDirectory = exactAbsolutePath(homedir(), "homeDirectory");
  const path = morrowClientConfigPath({ client, scope, projectRoot: configurationRoot, homeDirectory });
  const clientConfigurationRoot = scope === "project"
    ? configurationRoot
    : client === "claude-desktop" && process.platform === "win32"
      ? dirname(dirname(path))
      : homeDirectory;
  assertNoSymlinkPath(clientConfigurationRoot, path);
  const expectedEntry = client === "codex"
    ? tomlObject(
      codexMcpServer(parseCodexToml(path, codexSection(bundle)), bundle.serverName, path),
      `${path}.mcp_servers.${bundle.serverName}`,
    )
    : serverEntry(bundle, client, canonicalUpstreamConfigPath);
  const write: ClientEntryWrite = {
    ...(expectedConfigSha256 !== undefined ? { expectedConfigSha256 } : {}),
    replaceMorrowEntry: options.replaceMorrowEntry === true,
  };
  const changed = client === "codex"
    ? installCodexEntry(path, bundle.serverName, codexSection(bundle), write)
    : installJsonEntry(path, CLIENT_JSON[client].container, bundle.serverName, expectedEntry, write);
  const container = client === "codex" ? undefined : CLIENT_JSON[client].container;
  const sha256 = installedClientDigest(path, client, container, bundle.serverName, expectedEntry);
  return { client, scope, path, changed, sha256 };
}

export function buildClientParityReport(options: ClientConfigBundleOptions): ClientParityReport {
  const bundle = buildClientConfigBundle(options);
  const clients = SUPPORTED_MORROW_CLIENTS.map((client) => {
    const entry = serverEntry(bundle, client, options.upstreamConfigPath);
    const pinned = entry.cwd !== undefined;
    // Equivalence covers the working directory, so a client whose file pins none is not equivalent.
    const equivalent = entry.command === bundle.command
      && JSON.stringify(entry.args) === JSON.stringify(bundle.args)
      && pinned && entry.cwd === bundle.cwd
      && JSON.stringify(entry.env) === JSON.stringify({ MORROW_UPSTREAMS_FILE: options.upstreamConfigPath });
    return {
      client,
      command: String(entry.command),
      args: Array.isArray(entry.args) ? entry.args.map(String) : [],
      ...(pinned ? { cwd: String(entry.cwd) } : {}),
      workingDirectory: pinned ? "pinned" as const : "client_default" as const,
      environmentNames: Object.keys(jsonObject(entry.env, `${client}.env`)).sort(),
      equivalent,
    };
  });
  return {
    schema: "morrow.client-parity-report.v1",
    proofLevel: "hermetic_config_only",
    realClientExecution: "not_run",
    scenarios: [
      "health",
      "catalog_search",
      "canvas_read",
      "write_plan",
      "approval_required_response",
      "separate_approval",
      "single_dispatch",
      "fresh_verification",
      "batch_start",
      "batch_status_and_paged_results",
      "report_export",
    ],
    clients,
  };
}

export function writeClientConfigBundle(
  options: WriteClientConfigBundleOptions,
): ClientConfigBundle {
  const outputDirectory = exactAbsolutePath(options.outputDirectory, "outputDirectory");
  const outputParent = dirname(outputDirectory);
  if (outputParent === outputDirectory) throw new Error("outputDirectory cannot be a filesystem root");
  const bundle = buildClientConfigBundle(options);
  assertRegularFile(bundle.args[0]!, "Morrow server entry");
  assertRegularFile(exactAbsolutePath(options.upstreamConfigPath, "upstreamConfigPath"), "Upstream configuration");
  mkdirSync(outputParent, { recursive: true, mode: 0o700 });

  const expectedNames = new Set(bundle.files.map((entry) => entry.path));
  if (existsSync(outputDirectory)) {
    const info = lstatSync(outputDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Refusing to replace ${outputDirectory} because it is not a regular directory`);
    }
    const unknown = readdirSync(outputDirectory).filter((name) => !expectedNames.has(name));
    if (unknown.length !== 0) {
      throw new Error(`Refusing to replace ${outputDirectory} because it contains files Morrow does not own`);
    }
  }
  for (const entry of bundle.files) {
    const destination = resolve(outputDirectory, entry.path);
    if (existsSync(destination) && options.force !== true) {
      throw new Error(`Refusing to overwrite ${destination} without force=true`);
    }
  }

  const transactionId = `${process.pid}-${randomUUID()}`;
  const stagingDirectory = `${outputDirectory}.staging-${transactionId}`;
  const previousDirectory = `${outputDirectory}.previous-${transactionId}`;
  let previousMoved = false;
  let published = false;
  try {
    mkdirSync(stagingDirectory, { mode: 0o700 });
    safeChmod(stagingDirectory, 0o700);
    for (const entry of bundle.files) {
      const destination = resolve(stagingDirectory, entry.path);
      if (dirname(destination) !== stagingDirectory) throw new Error("Morrow generated an invalid client bundle path");
      const mode = entry.path === "install.posix.sh" ? 0o700 : 0o600;
      writeRestrictedFile(destination, entry.content, mode, options.restriction);
    }
    if (existsSync(outputDirectory)) {
      renameSync(outputDirectory, previousDirectory);
      previousMoved = true;
    }
    try {
      renameSync(stagingDirectory, outputDirectory);
      published = true;
    } catch (error) {
      if (previousMoved && !existsSync(outputDirectory)) {
        renameSync(previousDirectory, outputDirectory);
        previousMoved = false;
      }
      throw error;
    }
  } finally {
    if (existsSync(stagingDirectory)) rmSync(stagingDirectory, { recursive: true, force: true });
    if (published && previousMoved && existsSync(previousDirectory)) {
      rmSync(previousDirectory, { recursive: true, force: true });
    }
  }
  return bundle;
}
