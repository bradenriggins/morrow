import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { sha256Text, type SourceAttestationHealth } from "@morrow/contracts";

export interface LocalGitSourceAttestationConfig {
  readonly kind: "local-git";
  readonly root: string;
  readonly expectedRevision: string;
  readonly requireTrackedClean: boolean;
  readonly expectedToolCount?: number;
  readonly expectedCatalogDigest?: string;
}

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
    }).trim();
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

function exactCatalogDigest(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new SourceAttestationError(
      "source_catalog_digest_invalid",
      "expectedCatalogDigest must be a SHA-256 digest.",
    );
  }
  return normalized;
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

  const trackedStatus = git(root, "status", "--porcelain=v1", "--untracked-files=no");
  const trackedClean = trackedStatus === "";
  if (config.requireTrackedClean && !trackedClean) {
    throw new SourceAttestationError(
      "source_tracked_changes_present",
      `Source ${sourceId} has tracked worktree changes. Refusing a non-reproducible donor process.`,
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
    requireTrackedClean: config.requireTrackedClean,
    rootDigest: sha256Text(root),
    verifiedAt: now().toISOString(),
    ...(expectedToolCount !== undefined ? { expectedToolCount } : {}),
    ...(expectedCatalogDigest ? { expectedCatalogDigest } : {}),
  };
}
