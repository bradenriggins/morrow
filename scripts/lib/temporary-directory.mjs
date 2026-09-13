import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withTemporaryDirectory(prefix, body) {
  if (typeof prefix !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(prefix)) {
    throw new TypeError("temporary directory prefix is invalid");
  }
  if (typeof body !== "function") throw new TypeError("temporary directory body is invalid");
  const directory = await mkdtemp(join(tmpdir(), prefix));
  let result;
  let bodyError;
  try {
    result = await body(directory);
  } catch (error) {
    bodyError = error;
  }
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (cleanupError) {
    if (bodyError) throw new AggregateError([bodyError, cleanupError], "temporary directory body and cleanup failed");
    throw cleanupError;
  }
  if (bodyError) throw bodyError;
  return result;
}
