import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  isAbsolute,
  dirname,
  join,
  relative,
  resolve,
} from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { sha256Text } from "@morrow/contracts";

export const SUPPORTED_MORROW_CLIENTS = Object.freeze([
  "codex",
  "claude-code",
  "claude-desktop",
  "gemini-cli",
] as const);
export type SupportedMorrowClient = typeof SUPPORTED_MORROW_CLIENTS[number];
export const MORROW_CLIENT_SCOPES = Object.freeze(["project", "user"] as const);
export type MorrowClientScope = typeof MORROW_CLIENT_SCOPES[number];

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

export interface InstallMorrowClientOptions extends ClientConfigBundleOptions {
  readonly client: SupportedMorrowClient;
  readonly scope?: MorrowClientScope;
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
    readonly cwd: string;
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
    "# Use `morrow mcp install <client> --scope project` for safe project configuration writes.",
    "# Codex project configuration is .codex/config.toml; its documented mcp add command is user scoped.",
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
    "# Codex project configuration is .codex/config.toml; its documented mcp add command is user scoped.",
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
    "- codex.config.toml: merge into user or project Codex configuration.",
    "- claude.mcp.json: merge the mcpServers entry into Claude Code configuration.",
    "- claude-desktop.config.json: merge the mcpServers entry into the Claude desktop chat configuration.",
    "- gemini.settings.json: merge the mcpServers entry into Gemini CLI settings.",
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
    "2. Install the Morrow Canvas Connector extension and pair it with the local MCP.",
    "3. Open one signed-in Canvas course in Chrome and connect that exact account in the extension popup.",
    "4. Connect the AI client and call morrow_health.",
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
    file("claude-desktop.config.json", claudeConfig(shared)),
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

function writePrivateText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  safeChmod(dirname(path), 0o700);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  safeChmod(temporary, 0o600);
  renameSync(temporary, path);
  safeChmod(path, 0o600);
}

export function buildLocalCanvasConfig(
  repositoryRootValue: string,
  nodeCommandValue: string = process.execPath,
): Record<string, unknown> {
  const repositoryRoot = exactAbsolutePath(repositoryRootValue, "repositoryRoot");
  const nodeCommand = exactCommand(nodeCommandValue);
  return {
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    upstreams: [{
      id: "canvas-session",
      label: "Morrow Canvas Connector",
      kind: "mcp-stdio",
      command: nodeCommand,
      args: [resolve(repositoryRoot, "packages/canvas-connector-mcp/dist/index.js")],
      cwd: repositoryRoot,
      env: {
        MORROW_CANVAS_CATALOG_PATH: resolve(repositoryRoot, "artifacts/canvas-api/canvas-api-catalog.json"),
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
    }, {
      id: "lms-api",
      label: "Moodle and Blackboard",
      kind: "mcp-stdio",
      command: nodeCommand,
      args: [resolve(repositoryRoot, "packages/mcp-server/dist/lms-api-entry.js")],
      cwd: repositoryRoot,
      sourceDisposition: "direct_owned",
      priority: 150,
      required: true,
      outputPrivacyDefault: {
        fieldPolicy: "scrub-sensitive",
        dataClass: "course",
        maxRecords: 10_000,
        maxBytes: 2_000_000,
        freeText: "allow",
        learnerTokens: true,
        artifactInspection: "deny",
      },
    }],
    sourcePolicy: { requireAttestation: false },
    publicationPolicy: { requiredForPublicProfile: false },
    filters: { excludePrefixes: ["mindtap_", "connect_"], excludeNames: [] },
    operationJournal: { path: resolve(repositoryRoot, ".morrow/morrow.sqlite3") },
    batchScheduler: { maxConcurrentWindows: 1 },
    privacy: {
      canvasOrigin: "browser-session",
      account: "local-browser-account",
      principal: "local-browser-principal",
      learnerVaultPath: resolve(repositoryRoot, ".morrow/learner-vault.json"),
    },
    maxCatalogTools: 2_000,
  };
}

export function writeLocalCanvasConfig(input: {
  readonly repositoryRoot: string;
  readonly path?: string;
  readonly nodeCommand?: string;
  readonly force?: boolean;
}): LocalCanvasConfiguration {
  const repositoryRoot = exactAbsolutePath(input.repositoryRoot, "repositoryRoot");
  const path = input.path ? exactAbsolutePath(input.path, "configuration path") : resolve(repositoryRoot, "morrow.upstreams.json");
  const extensionPath = resolve(repositoryRoot, "connector/extension");
  for (const [candidate, label] of [
    [resolve(repositoryRoot, "packages/mcp-server/dist/index.js"), "Morrow MCP server"],
    [resolve(repositoryRoot, "packages/mcp-server/dist/lms-api-entry.js"), "Moodle and Blackboard connection"],
    [resolve(repositoryRoot, "packages/canvas-connector-mcp/dist/index.js"), "Canvas connector MCP"],
    [resolve(repositoryRoot, "artifacts/canvas-api/canvas-api-catalog.json"), "Canvas API catalog"],
    [resolve(extensionPath, "manifest.json"), "Chrome connector extension"],
  ] as const) assertRegularFile(candidate, label);
  const content = jsonFile(buildLocalCanvasConfig(repositoryRoot, input.nodeCommand));
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") === content) return { path, extensionPath, changed: false };
    if (input.force !== true) throw new Error(`Refusing to replace existing Morrow configuration at ${path}`);
  }
  writePrivateText(path, content);
  return { path, extensionPath, changed: true };
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
    throw new TypeError("client must be codex, claude-code, claude-desktop, or gemini-cli");
  }
  return client;
}

function installPath(
  client: SupportedMorrowClient,
  scope: MorrowClientScope,
  repositoryRoot: string,
): string {
  const root = scope === "project" ? repositoryRoot : homedir();
  switch (client) {
    case "codex": return join(root, ".codex", "config.toml");
    case "claude-code": return scope === "project" ? join(root, ".mcp.json") : join(root, ".claude.json");
    case "claude-desktop": {
      if (scope !== "user") throw new TypeError("Claude desktop chat supports only --scope user");
      if (process.platform === "darwin") return join(root, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "Claude", "claude_desktop_config.json");
      throw new TypeError("Claude desktop chat installation is supported on macOS and Windows");
    }
    case "gemini-cli": return join(root, ".gemini", "settings.json");
  }
}

function serverEntry(
  bundle: ClientConfigBundle,
  client: SupportedMorrowClient,
  upstreamConfigPath?: string,
): Record<string, unknown> {
  const name = client === "codex" ? "codex.config.toml"
    : client === "claude-code" ? "claude.mcp.json"
      : client === "claude-desktop" ? "claude-desktop.config.json"
      : "gemini.settings.json";
  const content = bundle.files.find((entry) => entry.path === name)?.content;
  if (!content) throw new Error(`Morrow did not generate ${name}`);
  if (client === "codex") {
    return {
      command: bundle.command,
      args: [...bundle.args],
      cwd: bundle.cwd,
      env: { MORROW_UPSTREAMS_FILE: exactAbsolutePath(upstreamConfigPath || "", "upstreamConfigPath") },
    };
  }
  const parsed = jsonObject(JSON.parse(content), name);
  return jsonObject(jsonObject(parsed.mcpServers, `${name}.mcpServers`)[bundle.serverName], `${name}.${bundle.serverName}`);
}

function codexSection(bundle: ClientConfigBundle): string {
  const fragment = bundle.files.find((entry) => entry.path === "codex.config.toml")?.content;
  if (!fragment) throw new Error("Morrow did not generate the Codex configuration");
  return fragment;
}

function installJsonEntry(path: string, serverName: string, entry: Record<string, unknown>): boolean {
  const document = existsSync(path)
    ? jsonObject(JSON.parse(readFileSync(path, "utf8")), path)
    : {};
  const mcpServers = document.mcpServers === undefined
    ? {}
    : jsonObject(document.mcpServers, `${path}.mcpServers`);
  const existing = mcpServers[serverName];
  if (existing !== undefined) {
    if (JSON.stringify(existing) === JSON.stringify(entry)) return false;
    throw new Error(`Refusing to replace existing Morrow server ${serverName} in ${path}`);
  }
  document.mcpServers = { ...mcpServers, [serverName]: entry };
  writePrivateText(path, jsonFile(document));
  return true;
}

function installCodexEntry(path: string, serverName: string, section: string): boolean {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const heading = `[mcp_servers.${serverName}]`;
  if (current.includes(heading)) {
    if (current.includes(section.trim())) return false;
    throw new Error(`Refusing to replace existing Morrow server ${serverName} in ${path}`);
  }
  writePrivateText(path, `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${section}`);
  return true;
}

export function installMorrowClient(options: InstallMorrowClientOptions): InstalledMorrowClient {
  const bundle = buildClientConfigBundle(options);
  assertRegularFile(bundle.args[0]!, "Morrow server entry");
  assertRegularFile(exactAbsolutePath(options.upstreamConfigPath, "upstreamConfigPath"), "Upstream configuration");
  const client = exactClient(options.client);
  const scope = exactScope(options.scope);
  const path = installPath(client, scope, bundle.cwd);
  const changed = client === "codex"
    ? installCodexEntry(path, bundle.serverName, codexSection(bundle))
    : installJsonEntry(path, bundle.serverName, serverEntry(bundle, client));
  return { client, scope, path, changed };
}

export function buildClientParityReport(options: ClientConfigBundleOptions): ClientParityReport {
  const bundle = buildClientConfigBundle(options);
  const clients = SUPPORTED_MORROW_CLIENTS.map((client) => {
    const entry = serverEntry(bundle, client, options.upstreamConfigPath);
    const equivalent = entry.command === bundle.command
      && JSON.stringify(entry.args) === JSON.stringify(bundle.args)
      && entry.cwd === bundle.cwd
      && JSON.stringify(entry.env) === JSON.stringify({ MORROW_UPSTREAMS_FILE: options.upstreamConfigPath });
    return {
      client,
      command: String(entry.command),
      args: Array.isArray(entry.args) ? entry.args.map(String) : [],
      cwd: String(entry.cwd),
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
