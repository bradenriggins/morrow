import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  type Stats,
} from "node:fs";
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
    named = lstatSync(path);
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDWR | noFollow);
  try {
    const opened = fstatSync(descriptor);
    const current = lstatSync(path);
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(named, opened) || !sameFile(opened, current)) {
      throw new Error(`${label} changed during admission`);
    }
    return opened;
  } finally {
    closeSync(descriptor);
  }
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
