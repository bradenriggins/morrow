import { lstatSync, type Stats } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type DatabaseSyncOptions } from "node:sqlite";
import { hardenPrivateFile, privateDirectoryAccessAccepted, privateFileAccessAccepted } from "./private-file-access.js";
import {
  canonicalPrivateStateFilePath,
  createExactPrivateStateFile,
} from "./private-state-file.js";

const SQLITE_SIDECAR_SUFFIXES = ["-journal", "-wal", "-shm"] as const;

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Proves one database path names a single-link owner-private regular file
 * using path metadata only. It never opens a descriptor on the path: POSIX
 * advisory locks belong to the process, so closing any descriptor for an
 * inode this process already holds open through SQLite would silently drop
 * the SHARED and shared-memory locks SQLite still believes it holds.
 */
function exactPrivateIdentity(path: string, label: string, repairAccess: boolean): Stats | null {
  let named: Stats;
  try { named = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1
    || (typeof process.getuid === "function" && named.uid !== process.getuid())) {
    throw new Error(`${label} is not one exact private file`);
  }
  if (!privateFileAccessAccepted(path, named.mode, { trustedRoot: dirname(path) })) {
    if (!repairAccess || !hardenPrivateFile(path, { trustedRoot: dirname(path) })) {
      throw new Error(`${label} access is not private`);
    }
    const hardened = lstatSync(path);
    if (!hardened.isFile() || hardened.isSymbolicLink() || hardened.nlink !== 1 || !sameFile(named, hardened)) {
      throw new Error(`${label} changed during admission`);
    }
    named = hardened;
  }
  return named;
}

function verifySidecars(path: string, label: string, repairAccess: boolean): void {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    exactPrivateIdentity(`${path}${suffix}`, `${label} ${suffix.slice(1)} file`, repairAccess);
  }
}

/**
 * Opens one file-backed SQLite authority database only through a canonical,
 * single-link, owner-private file. SQLite sidecars receive and retain the same
 * private access before the connection is returned.
 */
export function openExactPrivateSqliteDatabase(
  pathValue: string,
  label: string,
  options: DatabaseSyncOptions = {},
): { readonly path: string; readonly database: DatabaseSync } {
  if (pathValue === ":memory:") {
    return { path: pathValue, database: new DatabaseSync(pathValue, options) };
  }
  if (options.open === false || options.readOnly === true) {
    throw new TypeError(`${label} requires one writable opened database`);
  }
  const path = canonicalPrivateStateFilePath(resolve(pathValue), label);
  if (!privateDirectoryAccessAccepted(dirname(path))) {
    throw new Error(`${label} directory access is not private`);
  }
  let identity = exactPrivateIdentity(path, label, true);
  if (identity === null) {
    if (!createExactPrivateStateFile(path, Buffer.alloc(0), { label, minBytes: 0, maxBytes: 0 })) {
      identity = exactPrivateIdentity(path, label, true);
    } else {
      identity = exactPrivateIdentity(path, label, false);
    }
  }
  if (identity === null) throw new Error(`${label} could not be created`);
  verifySidecars(path, label, true);
  // From here on SQLite owns descriptors on the database and its sidecars, so
  // every later check reads path metadata only and repairs nothing in place.
  const database = new DatabaseSync(path, options);
  try {
    database.exec("PRAGMA journal_mode = WAL;");
    const current = exactPrivateIdentity(path, label, false);
    if (current === null || !sameFile(identity, current)) throw new Error(`${label} changed while it was opened`);
    verifySidecars(path, label, false);
    return { path, database };
  } catch (error) {
    try { database.close(); } catch { /* preserve the primary failure */ }
    throw error;
  }
}
