import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { withTemporaryDirectory } from "../lib/temporary-directory.mjs";

async function absent(path) {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

test("temporary application state is removed after success", async () => {
  let observed;
  const result = await withTemporaryDirectory("morrow-cleanup-success-", async (directory) => {
    observed = directory;
    await writeFile(join(directory, "state.json"), "private state\n");
    return "complete";
  });
  assert.equal(result, "complete");
  assert.equal(await absent(observed), true);
});

test("temporary application state is removed after failure", async () => {
  let observed;
  await assert.rejects(
    withTemporaryDirectory("morrow-cleanup-failure-", async (directory) => {
      observed = directory;
      await writeFile(join(directory, "state.json"), "private state\n");
      throw new Error("synthetic smoke failure");
    }),
    /synthetic smoke failure/,
  );
  assert.equal(await absent(observed), true);
});
