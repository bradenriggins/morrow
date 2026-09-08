import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  realpathSync,
  statSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
import { parse as parseToml } from "@iarna/toml";
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
}

export interface InstallMorrowClientOptions extends ClientConfigBundleOptions {
  readonly client: SupportedMorrowClient;
  readonly scope?: MorrowClientScope;
  readonly projectRoot?: string;
}

export interface InstalledMorrowClient {
  readonly client: SupportedMorrowClient;
  readonly scope: MorrowClientScope;
  readonly path: string;
  readonly changed: boolean;
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
    "required = true",
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
    "- cursor.mcp.json: merge the mcpServers entry into .cursor/mcp.json or ~/.cursor/mcp.json. Cursor documents no cwd field, so Morrow uses the directory Cursor starts it in.",
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
    "9. Approve only on the separate loopback approval page.",
    "10. Dispatch once and require connector-owned fresh readback before stating success.",
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

function safeChmod(path: string, mode: number): void {
  try { chmodSync(path, mode); } catch { /* best effort on non-POSIX filesystems */ }
}

interface ExpectedFileText {
  readonly exists: boolean;
  readonly content: string;
}

function currentFileText(path: string): ExpectedFileText {
  return existsSync(path)
    ? { exists: true, content: readFileSync(path, "utf8") }
    : { exists: false, content: "" };
}

function sameFileText(left: ExpectedFileText, right: ExpectedFileText): boolean {
  return left.exists === right.exists && left.content === right.content;
}

function writePrivateText(path: string, content: string, expected?: ExpectedFileText): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  safeChmod(dirname(path), 0o700);
  if (expected && !sameFileText(currentFileText(path), expected)) {
    throw new Error(`Refusing to replace ${path} because it changed during installation`);
  }
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    safeChmod(temporary, 0o600);
    if (expected && !sameFileText(currentFileText(path), expected)) {
      throw new Error(`Refusing to replace ${path} because it changed during installation`);
    }
    renameSync(temporary, path);
    safeChmod(path, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
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
    return ["This is the documented Windows location for Claude Desktop. Morrow has not confirmed a write here on a Windows computer. In Claude Desktop, open Settings, Developer, Edit Config, and check that Morrow is listed."];
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

function parseClientJson(path: string, content: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Refusing to replace ${path} because it is not valid JSON: ${detail}`);
  }
  return jsonObject(parsed, path);
}

function installJsonEntry(
  path: string,
  container: string,
  serverName: string,
  entry: Record<string, unknown>,
): boolean {
  const current = currentFileText(path);
  const document = current.exists
    ? parseClientJson(path, current.content)
    : {};
  const servers = document[container] === undefined
    ? {}
    : jsonObject(document[container], `${path}.${container}`);
  const existing = servers[serverName];
  if (existing !== undefined) {
    if (JSON.stringify(existing) === JSON.stringify(entry)) return false;
    throw new Error(`Refusing to replace existing Morrow server ${serverName} in ${path}`);
  }
  document[container] = { ...servers, [serverName]: entry };
  writePrivateText(path, jsonFile(document), current);
  return true;
}

function tomlObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a TOML table`);
  }
  return value as Record<string, unknown>;
}

function parseCodexToml(path: string, content: string): Record<string, unknown> {
  try {
    return tomlObject(parseToml(content), path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Refusing to replace ${path} because it is not valid TOML: ${detail}`);
  }
}

function codexMcpServer(document: Record<string, unknown>, serverName: string, path: string): unknown {
  const servers = document.mcp_servers;
  if (servers === undefined) return undefined;
  return tomlObject(servers, `${path}.mcp_servers`)[serverName];
}

function installCodexEntry(path: string, serverName: string, section: string): boolean {
  const current = currentFileText(path);
  const document = parseCodexToml(path, current.content);
  const expected = codexMcpServer(parseCodexToml(path, section), serverName, path);
  const existing = codexMcpServer(document, serverName, path);
  if (existing !== undefined) {
    if (isDeepStrictEqual(existing, expected)) return false;
    throw new Error(`Refusing to replace existing Morrow server ${serverName} in ${path}`);
  }
  const content = `${current.content.trimEnd()}${current.content.trim() ? "\n\n" : ""}${section}`;
  try {
    parseCodexToml(path, content);
  } catch {
    throw new Error(`Refusing to add Morrow to ${path} without rewriting existing TOML`);
  }
  writePrivateText(path, content, current);
  return true;
}

export function installMorrowClient(options: InstallMorrowClientOptions): InstalledMorrowClient {
  const client = exactClient(options.client);
  const scope = exactScope(options.scope);
  const repositoryRoot = exactAbsolutePath(options.repositoryRoot, "repositoryRoot");
  if (scope === "user" && options.projectRoot !== undefined) {
    throw new TypeError("projectRoot is supported only for project-scoped client configuration");
  }
  const configurationRoot = scope === "project"
    ? canonicalDirectory(options.projectRoot || repositoryRoot, "projectRoot")
    : repositoryRoot;
  const workspaceRoot = options.workspaceRoot === undefined
    ? configurationRoot
    : canonicalDirectory(options.workspaceRoot, "workspaceRoot");
  const bundle = buildClientConfigBundle({ ...options, workspaceRoot });
  assertRegularFile(bundle.args[0]!, "Morrow server entry");
  assertRegularFile(exactAbsolutePath(options.upstreamConfigPath, "upstreamConfigPath"), "Upstream configuration");
  const path = morrowClientConfigPath({ client, scope, projectRoot: configurationRoot });
  const changed = client === "codex"
    ? installCodexEntry(path, bundle.serverName, codexSection(bundle))
    : installJsonEntry(path, CLIENT_JSON[client].container, bundle.serverName, serverEntry(bundle, client));
  return { client, scope, path, changed };
}

export function buildClientParityReport(options: ClientConfigBundleOptions): ClientParityReport {
  const bundle = buildClientConfigBundle(options);
  const clients = SUPPORTED_MORROW_CLIENTS.map((client) => {
    const entry = serverEntry(bundle, client, options.upstreamConfigPath);
    const pinned = entry.cwd !== undefined;
    const equivalent = entry.command === bundle.command
      && JSON.stringify(entry.args) === JSON.stringify(bundle.args)
      && (!pinned || entry.cwd === bundle.cwd)
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
