import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, relative, resolve } from "node:path";
import {
  sha256Json,
  sha256Text,
  type SourceAttestationHealth,
} from "@morrow/contracts";

export interface LocalGitSourceAttestationConfig {
  readonly kind: "local-git";
  readonly root: string;
  readonly expectedRevision: string;
  readonly requireTrackedClean: boolean;
  readonly allowedTrackedPaths?: readonly string[];
  readonly expectedTrackedPatchDigest?: string;
  readonly expectedToolCount?: number;
  readonly expectedCatalogDigest?: string;
}

export interface LocalGitLaunchAttestationConfig {
  readonly entrypoint: string;
  readonly entrypointArgumentIndex: number;
  readonly expectedEntrypointSha256?: string;
  readonly runtime:
    | { readonly kind: "current-node" }
    | { readonly kind: "sha256"; readonly expectedExecutableSha256: string };
}

export interface LocalStdioLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface VerifiedLocalGitStdioLaunch {
  readonly launch: LocalStdioLaunch;
  readonly attestation: SourceAttestationHealth;
}

export interface RemoteGitSshSourceAttestationConfig {
  readonly kind: "remote-git-ssh";
  readonly host: string;
  readonly root: string;
  readonly expectedRevision: string;
  readonly requireTrackedClean: true;
}

export type SshAttestationRunner = (
  command: "ssh",
  args: readonly string[],
  options: { readonly input: string; readonly timeout: number },
) => string;

export class SourceAttestationError extends Error {
  readonly code: string;
  readonly detailDigest: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SourceAttestationError";
    this.code = code;
    this.detailDigest = sha256Text(`${code}:${message}`);
  }
}

function git(root: string, ...args: string[]): string {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SourceAttestationError(
      "source_git_command_failed",
      `The configured donor checkout could not be inspected by Git. ${message}`,
    );
  }
}

function gitRaw(root: string, ...args: string[]): string {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SourceAttestationError(
      "source_git_command_failed",
      `The configured donor checkout could not be inspected by Git. ${message}`,
    );
  }
}

function exactRevision(value: string, label: string): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(normalized)) {
    throw new SourceAttestationError(
      "source_revision_invalid",
      `${label} must be a full hexadecimal Git object id.`,
    );
  }
  return normalized;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function defaultSshAttestationRunner(
  command: "ssh",
  args: readonly string[],
  options: { readonly input: string; readonly timeout: number },
): string {
  try {
    return execFileSync(command, [...args], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      input: options.input,
      timeout: options.timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new SourceAttestationError(
      "source_git_ssh_command_failed",
      "The remote donor could not be inspected over SSH.",
    );
  }
}

function exactToolCount(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > 5_000) {
    throw new SourceAttestationError(
      "source_tool_count_invalid",
      "expectedToolCount must be a whole number from 1 through 5000.",
    );
  }
  return value;
}

function exactDigest(
  value: string | undefined,
  label: string,
  code: string,
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new SourceAttestationError(code, `${label} must be a SHA-256 digest.`);
  }
  return normalized;
}

function exactCatalogDigest(value: string | undefined): string | undefined {
  return exactDigest(
    value,
    "expectedCatalogDigest",
    "source_catalog_digest_invalid",
  );
}

function exactPatchDigest(value: string | undefined): string | undefined {
  return exactDigest(
    value,
    "expectedTrackedPatchDigest",
    "source_patch_digest_invalid",
  );
}

function repositoryRoot(value: string): string {
  const configured = String(value || "").trim();
  if (!configured) {
    throw new SourceAttestationError(
      "source_root_missing",
      "A local Git source attestation requires an exact repository root.",
    );
  }
  const candidate = isAbsolute(configured) ? configured : resolve(configured);
  let root: string;
  try {
    root = realpathSync(candidate);
  } catch {
    throw new SourceAttestationError(
      "source_root_unavailable",
      "The configured donor repository root does not exist or is not readable.",
    );
  }
  if (!statSync(root).isDirectory()) {
    throw new SourceAttestationError(
      "source_root_not_directory",
      "The configured donor repository root is not a directory.",
    );
  }
  return root;
}

function assertGitTopLevel(root: string): void {
  const topLevel = realpathSync(git(root, "rev-parse", "--show-toplevel"));
  if (relative(root, topLevel) !== "") {
    throw new SourceAttestationError(
      "source_root_not_repository_root",
      "The configured donor root must be the exact Git worktree root.",
    );
  }
}

function exactTrackedPath(value: unknown): string {
  if (typeof value !== "string") {
    throw new SourceAttestationError(
      "source_tracked_path_invalid",
      "Each allowed tracked path must be a string.",
    );
  }
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  const segments = normalized.split("/");
  if (
    !normalized
    || normalized.startsWith("/")
    || /^[A-Za-z]:\//.test(normalized)
    || segments.some((segment) => !segment || segment === "." || segment === "..")
    || /[\0\r\n]/.test(normalized)
  ) {
    throw new SourceAttestationError(
      "source_tracked_path_invalid",
      `Allowed tracked path ${String(value)} is not a safe repository-relative path.`,
    );
  }
  return normalized;
}

function allowedTrackedPaths(values: readonly string[] | undefined): readonly string[] {
  const normalized = (values || []).map(exactTrackedPath).sort();
  if (new Set(normalized).size !== normalized.length) {
    throw new SourceAttestationError(
      "source_tracked_path_duplicate",
      "Allowed tracked paths contain a duplicate.",
    );
  }
  if (normalized.length > 20) {
    throw new SourceAttestationError(
      "source_tracked_path_limit",
      "A source attestation may allow no more than 20 tracked paths.",
    );
  }
  return normalized;
}

function changedTrackedPaths(root: string): readonly string[] {
  const raw = gitRaw(root, "diff", "--name-only", "-z", "HEAD", "--");
  const paths = raw
    .split("\0")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(exactTrackedPath)
    .sort();
  return [...new Set(paths)];
}

function trackedPatchDigest(root: string): string {
  return sha256Text(gitRaw(root, "diff", "--binary", "--no-ext-diff", "HEAD", "--"));
}

function fileDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function canonicalExistingFile(path: string, code: string, message: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    throw new SourceAttestationError(code, message);
  }
  if (!statSync(canonical).isFile()) {
    throw new SourceAttestationError(code, message);
  }
  return canonical;
}

function executableCandidates(command: string, cwd: string, environment: Readonly<Record<string, string>>): readonly string[] {
  if (isAbsolute(command)) return [command];
  if (command.includes("/") || command.includes("\\")) return [resolve(cwd, command)];
  const paths = String(environment.PATH || environment.Path || "").split(delimiter).filter(Boolean);
  if (process.platform !== "win32") return paths.map((path) => resolve(path, command));
  const extensions = String(environment.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  return paths.flatMap((path) => extensions.map((extension) => resolve(path, `${command}${extension}`)));
}

function canonicalExecutable(
  command: string,
  cwd: string,
  environment: Readonly<Record<string, string>>,
): string {
  for (const candidate of executableCandidates(command, cwd, environment)) {
    try {
      accessSync(candidate, constants.X_OK);
      return canonicalExistingFile(
        candidate,
        "source_launch_executable_unavailable",
        "The attested launch executable does not exist or is not executable.",
      );
    } catch (error) {
      if (error instanceof SourceAttestationError) continue;
    }
  }
  throw new SourceAttestationError(
    "source_launch_executable_unavailable",
    "The attested launch executable could not be resolved through the exact launch environment.",
  );
}

function isTrackedAtHead(root: string, path: string): boolean {
  try {
    execFileSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", path], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 15_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

export function verifyLocalGitStdioLaunch(
  sourceId: string,
  repository: string | undefined,
  config: LocalGitSourceAttestationConfig & { readonly launch: LocalGitLaunchAttestationConfig },
  launch: LocalStdioLaunch,
  now: () => Date = () => new Date(),
): VerifiedLocalGitStdioLaunch {
  const base = verifyLocalGitSourceAttestation(sourceId, repository, config, now);
  const root = repositoryRoot(config.root);
  if (!launch.cwd) {
    throw new SourceAttestationError(
      "source_launch_cwd_missing",
      `Source ${sourceId} requires an explicit launch working directory.`,
    );
  }
  let cwd: string;
  try {
    cwd = realpathSync(launch.cwd);
  } catch {
    throw new SourceAttestationError(
      "source_launch_cwd_unavailable",
      `Source ${sourceId} launch working directory does not exist.`,
    );
  }
  if (cwd !== root) {
    throw new SourceAttestationError(
      "source_launch_cwd_mismatch",
      `Source ${sourceId} must launch from its exact attested Git worktree root.`,
    );
  }

  const entrypoint = exactTrackedPath(config.launch.entrypoint);
  const expectedEntrypoint = canonicalExistingFile(
    resolve(root, entrypoint),
    "source_launch_entrypoint_unavailable",
    `Source ${sourceId} attested entrypoint does not exist or is not a regular file.`,
  );
  const entrypointRelative = relative(root, expectedEntrypoint).replaceAll("\\", "/");
  if (!entrypointRelative || entrypointRelative.startsWith("../") || isAbsolute(entrypointRelative)) {
    throw new SourceAttestationError(
      "source_launch_entrypoint_outside_root",
      `Source ${sourceId} attested entrypoint resolves outside its Git worktree.`,
    );
  }
  const argumentIndex = config.launch.entrypointArgumentIndex;
  if (!Number.isSafeInteger(argumentIndex) || argumentIndex < 0 || argumentIndex >= launch.args.length) {
    throw new SourceAttestationError(
      "source_launch_entrypoint_argument_invalid",
      `Source ${sourceId} attested entrypoint argument does not exist.`,
    );
  }
  const configuredArgument = launch.args[argumentIndex]!;
  const actualEntrypoint = canonicalExistingFile(
    isAbsolute(configuredArgument) ? configuredArgument : resolve(cwd, configuredArgument),
    "source_launch_entrypoint_unavailable",
    `Source ${sourceId} launch entrypoint does not exist or is not a regular file.`,
  );
  if (actualEntrypoint !== expectedEntrypoint) {
    throw new SourceAttestationError(
      "source_launch_entrypoint_mismatch",
      `Source ${sourceId} launch does not execute the entrypoint inside its attested Git worktree.`,
    );
  }

  const entrypointDigest = fileDigest(actualEntrypoint);
  const expectedEntrypointDigest = exactDigest(
    config.launch.expectedEntrypointSha256,
    "expectedEntrypointSha256",
    "source_launch_entrypoint_digest_invalid",
  );
  if (!isTrackedAtHead(root, entrypoint) && !expectedEntrypointDigest) {
    throw new SourceAttestationError(
      "source_launch_entrypoint_untracked",
      `Source ${sourceId} launch entrypoint is not tracked at the attested revision and has no expected byte digest.`,
    );
  }
  if (expectedEntrypointDigest && entrypointDigest !== expectedEntrypointDigest) {
    throw new SourceAttestationError(
      "source_launch_entrypoint_digest_mismatch",
      `Source ${sourceId} launch entrypoint bytes do not match the configured digest.`,
    );
  }

  const executable = canonicalExecutable(launch.command, cwd, launch.env);
  const executableDigest = fileDigest(executable);
  if (config.launch.runtime.kind === "current-node") {
    if (executable !== realpathSync(process.execPath)) {
      throw new SourceAttestationError(
        "source_launch_runtime_mismatch",
        `Source ${sourceId} must use the current verified Node.js executable.`,
      );
    }
  } else {
    const expectedExecutableDigest = exactDigest(
      config.launch.runtime.expectedExecutableSha256,
      "expectedExecutableSha256",
      "source_launch_executable_digest_invalid",
    );
    if (executableDigest !== expectedExecutableDigest) {
      throw new SourceAttestationError(
        "source_launch_executable_digest_mismatch",
        `Source ${sourceId} launch executable bytes do not match the configured digest.`,
      );
    }
  }

  const args = [...launch.args];
  args[argumentIndex] = expectedEntrypoint;
  const canonicalLaunch: LocalStdioLaunch = {
    command: executable,
    args,
    cwd,
    env: { ...launch.env },
  };
  const launchDigest = sha256Json({
    schema: "morrow.local-stdio-launch.v1",
    sourceId,
    rootDigest: base.rootDigest,
    revision: base.actualRevision,
    executable,
    executableDigest,
    args,
    cwd,
    environment: Object.entries(launch.env).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    entrypointArgumentIndex: argumentIndex,
    entrypointDigest,
  });
  return {
    launch: canonicalLaunch,
    attestation: {
      ...base,
      launchDigest,
      executableDigest,
      entrypointDigest,
    },
  };
}

export function verifyLocalGitSourceAttestation(
  sourceId: string,
  repository: string | undefined,
  config: LocalGitSourceAttestationConfig,
  now: () => Date = () => new Date(),
): SourceAttestationHealth {
  const root = repositoryRoot(config.root);
  assertGitTopLevel(root);
  const expectedRevision = exactRevision(config.expectedRevision, "expectedRevision");
  const actualRevision = exactRevision(git(root, "rev-parse", "HEAD"), "Git HEAD");
  if (actualRevision !== expectedRevision) {
    throw new SourceAttestationError(
      "source_revision_mismatch",
      `Source ${sourceId} is at ${actualRevision}, not the configured revision ${expectedRevision}.`,
    );
  }

  const allowedPaths = allowedTrackedPaths(config.allowedTrackedPaths);
  const changedPaths = changedTrackedPaths(root);
  const trackedClean = changedPaths.length === 0;
  if (config.requireTrackedClean && !trackedClean) {
    throw new SourceAttestationError(
      "source_tracked_changes_present",
      `Source ${sourceId} has tracked worktree changes. Refusing a non-reproducible donor process.`,
    );
  }
  const disallowedPaths = changedPaths.filter((path) => !allowedPaths.includes(path));
  if (!config.requireTrackedClean && disallowedPaths.length > 0) {
    throw new SourceAttestationError(
      "source_unapproved_tracked_changes",
      `Source ${sourceId} has tracked changes outside its approved overlay paths: ${disallowedPaths.join(", ")}.`,
    );
  }

  const actualTrackedPatchDigest = trackedPatchDigest(root);
  const expectedTrackedPatchDigest = exactPatchDigest(config.expectedTrackedPatchDigest);
  if (
    expectedTrackedPatchDigest
    && actualTrackedPatchDigest !== expectedTrackedPatchDigest
  ) {
    throw new SourceAttestationError(
      "source_tracked_patch_mismatch",
      `Source ${sourceId} tracked patch does not match its configured digest.`,
    );
  }

  const expectedToolCount = exactToolCount(config.expectedToolCount);
  const expectedCatalogDigest = exactCatalogDigest(config.expectedCatalogDigest);
  return {
    schema: "morrow.source-attestation.v1",
    kind: "local-git",
    verified: true,
    sourceId,
    ...(repository ? { repository } : {}),
    expectedRevision,
    actualRevision,
    trackedClean,
    trackedChangeCount: changedPaths.length,
    requireTrackedClean: config.requireTrackedClean,
    rootDigest: sha256Text(root),
    verifiedAt: now().toISOString(),
    ...(allowedPaths.length > 0
      ? { allowedTrackedPathsDigest: sha256Json(allowedPaths) }
      : {}),
    ...(!trackedClean ? { trackedPatchDigest: actualTrackedPatchDigest } : {}),
    ...(expectedTrackedPatchDigest ? { expectedTrackedPatchDigest } : {}),
    ...(expectedToolCount !== undefined ? { expectedToolCount } : {}),
    ...(expectedCatalogDigest ? { expectedCatalogDigest } : {}),
  };
}

export function verifyRemoteGitSshSourceAttestation(
  sourceId: string,
  repository: string | undefined,
  config: RemoteGitSshSourceAttestationConfig,
  now: () => Date = () => new Date(),
  runner: SshAttestationRunner = defaultSshAttestationRunner,
): SourceAttestationHealth {
  const expectedRevision = exactRevision(config.expectedRevision, "expectedRevision");
  const script = [
    "set -eu",
    "root=$1",
    "revision=$(git -C \"$root\" rev-parse HEAD)",
    "if git -C \"$root\" diff --quiet --no-ext-diff HEAD --; then tracked=clean; else tracked=dirty; fi",
    "printf '%s\\n%s\\n' \"$revision\" \"$tracked\"",
  ].join("\n");
  const remoteCommand = `sh -s -- ${shellQuote(config.root)}`;
  const raw = runner("ssh", ["-T", config.host, remoteCommand], {
    input: script,
    timeout: 15_000,
  });
  const lines = raw.trim().split(/\r?\n/);
  if (lines.length !== 2 || !["clean", "dirty"].includes(lines[1]!)) {
    throw new SourceAttestationError(
      "source_git_ssh_response_invalid",
      "The remote Git attestation returned an invalid response.",
    );
  }
  const actualRevision = exactRevision(lines[0]!, "remote Git HEAD");
  if (actualRevision !== expectedRevision) {
    throw new SourceAttestationError(
      "source_revision_mismatch",
      `Source ${sourceId} is at ${actualRevision}, not the configured revision ${expectedRevision}.`,
    );
  }
  const trackedClean = lines[1] === "clean";
  if (!trackedClean) {
    throw new SourceAttestationError(
      "source_tracked_changes_present",
      `Source ${sourceId} has tracked worktree changes. Refusing a non-reproducible donor process.`,
    );
  }
  return {
    schema: "morrow.source-attestation.v1",
    kind: "remote-git-ssh",
    verified: true,
    sourceId,
    ...(repository ? { repository } : {}),
    expectedRevision,
    actualRevision,
    trackedClean: true,
    trackedChangeCount: 0,
    requireTrackedClean: true,
    rootDigest: sha256Text(config.root),
    verifiedAt: now().toISOString(),
  };
}
