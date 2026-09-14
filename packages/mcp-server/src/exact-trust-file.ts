import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

export interface ExactTrustFileOptions {
  readonly label: string;
  readonly maxBytes: number;
}

const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function exactMaximum(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} maximum bytes is invalid`);
  return value;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameFile(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

/** Reads one bounded regular file through a descriptor while preserving its named path identity. */
export function readExactTrustFile(pathValue: string, options: ExactTrustFileOptions): Buffer {
  const maximum = exactMaximum(options.maxBytes, options.label);
  const requestedPath = resolve(pathValue);
  const requestedParent = dirname(requestedPath);
  const namedParent = lstatSync(requestedParent, { bigint: true });
  if ((!namedParent.isDirectory() && !namedParent.isSymbolicLink())) {
    throw new Error(`${options.label} parent is not a directory`);
  }
  const canonicalParent = realpathSync(requestedParent);
  const canonicalParentIdentity = lstatSync(canonicalParent, { bigint: true });
  if (!canonicalParentIdentity.isDirectory()) throw new Error(`${options.label} parent is not a directory`);
  const path = resolve(canonicalParent, basename(requestedPath));
  const named = lstatSync(requestedPath, { bigint: true });
  if (!named.isFile() || named.isSymbolicLink() || named.size > BigInt(maximum)) {
    throw new Error(`${options.label} is not a bounded regular file`);
  }

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.size > BigInt(maximum) || !sameFile(named, opened)) {
      throw new Error(`${options.label} changed during admission`);
    }
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length !== Number(opened.size)) throw new Error(`${options.label} changed while it was read`);

    const afterRead = fstatSync(descriptor, { bigint: true });
    const currentParent = lstatSync(requestedParent, { bigint: true });
    const currentCanonicalParent = realpathSync(requestedParent);
    const currentCanonicalParentIdentity = lstatSync(currentCanonicalParent, { bigint: true });
    const current = lstatSync(requestedPath, { bigint: true });
    if (!sameSnapshot(opened, afterRead) || !sameFile(opened, current)
      || !sameFile(namedParent, currentParent)
      || currentCanonicalParent !== canonicalParent
      || !sameFile(canonicalParentIdentity, currentCanonicalParentIdentity)) {
      throw new Error(`${options.label} path changed while it was read`);
    }
    return bytes.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
}

export function readExactTrustJson(path: string, options: ExactTrustFileOptions): unknown {
  let text: string;
  try {
    text = strictUtf8Decoder.decode(readExactTrustFile(path, options)).replace(/^\uFEFF/u, "");
  } catch (error) {
    if (error instanceof TypeError) throw new Error(`${options.label} is not valid UTF-8`, { cause: error });
    throw error;
  }
  return JSON.parse(text) as unknown;
}
