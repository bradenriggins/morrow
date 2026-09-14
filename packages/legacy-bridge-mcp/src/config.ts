import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";
import { parseSourceCatalog, type SourceCatalogSnapshot } from "@morrow/gateway-core";

export const LEGACY_BRIDGE_MAX_CATALOG_BYTES = 16 * 1024 * 1024;

export interface LegacyBridgeConfig {
  readonly catalogPath: string;
  readonly sourceCatalog: SourceCatalogSnapshot;
  readonly token: string;
  readonly port: number;
  readonly expectedRevision: string;
  readonly allowedExtensionIds: readonly string[];
}

function requiredEnvironment(name: string, environment: NodeJS.ProcessEnv): string {
  const value = String(environment[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function exactPort(value: string | undefined): number {
  if (!value) return 32145;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("MORROW_LEGACY_BRIDGE_PORT must be a whole number from 1 through 65535");
  }
  return parsed;
}

function sameFile(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  // ctime can gain precision after a fresh write without any file mutation.
  return sameFile(left, right)
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid;
}

async function readCatalog(path: string): Promise<string> {
  const invalid = (): Error => new Error(
    "MORROW_LEGACY_CATALOG_PATH must name one stable regular file no larger than 16 MiB",
  );
  let handle;
  try {
    const namedBefore = await lstat(path);
    if (!namedBefore.isFile() || namedBefore.size < 1 || namedBefore.size > LEGACY_BRIDGE_MAX_CATALOG_BYTES) {
      throw invalid();
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const openedBefore = await handle.stat();
    if (!openedBefore.isFile() || !sameFile(namedBefore, openedBefore)
      || openedBefore.size < 1 || openedBefore.size > LEGACY_BRIDGE_MAX_CATALOG_BYTES) {
      throw invalid();
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, LEGACY_BRIDGE_MAX_CATALOG_BYTES + 1 - bytes));
      const read = await handle.read(chunk, 0, chunk.length, null);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
      if (bytes > LEGACY_BRIDGE_MAX_CATALOG_BYTES) throw invalid();
      chunks.push(Buffer.from(chunk.subarray(0, read.bytesRead)));
    }
    const openedAfter = await handle.stat();
    const namedAfter = await lstat(path);
    if (!sameStableFile(openedBefore, openedAfter) || !sameStableFile(openedAfter, namedAfter)
      || bytes !== openedAfter.size) {
      throw invalid();
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("MORROW_LEGACY_CATALOG_PATH must name")) throw error;
    throw invalid();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function loadLegacyBridgeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LegacyBridgeConfig> {
  const catalogPath = resolve(requiredEnvironment("MORROW_LEGACY_CATALOG_PATH", environment));
  const text = await readCatalog(catalogPath);
  const sourceCatalog = parseSourceCatalog(JSON.parse(text) as unknown);
  if (sourceCatalog.source.id !== "morrow-legacy") {
    throw new Error("MORROW_LEGACY_CATALOG_PATH must contain the morrow-legacy source catalog");
  }
  const expectedRevision = String(
    environment.MORROW_LEGACY_EXPECTED_REVISION || sourceCatalog.source.revision || "",
  ).trim();
  if (!expectedRevision || sourceCatalog.source.revision !== expectedRevision) {
    throw new Error("Morrow legacy catalog revision does not match MORROW_LEGACY_EXPECTED_REVISION");
  }
  const token = requiredEnvironment("MORROW_LEGACY_BRIDGE_TOKEN", environment);
  if (token.length < 32 || token.length > 512) {
    throw new Error("MORROW_LEGACY_BRIDGE_TOKEN must contain 32 to 512 characters");
  }
  const allowedExtensionIds = String(environment.MORROW_LEGACY_ALLOWED_EXTENSION_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (allowedExtensionIds.some((value) => !/^[a-p]{32}$/.test(value))) {
    throw new Error("MORROW_LEGACY_ALLOWED_EXTENSION_IDS contains an invalid Chrome extension id");
  }
  return {
    catalogPath,
    sourceCatalog,
    token,
    port: exactPort(environment.MORROW_LEGACY_BRIDGE_PORT),
    expectedRevision,
    allowedExtensionIds,
  };
}
