import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadLmsConnections } from "../src/lms-api.js";

describe("saved learning-platform connections", () => {
  it.skipIf(process.platform === "win32")("accepts owner-only files and safely rejects readable files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-lms-connections-"));
    const path = join(directory, "connections.json");
    const token = "synthetic-lms-token-value";
    const connection = {
      id: "school",
      label: "School",
      provider: "moodle",
      baseUrl: "https://school.example/moodle",
      token,
    };
    try {
      await writeFile(path, JSON.stringify({ schema: "morrow.lms-connections.v1", connections: [connection] }));
      await chmod(path, 0o600);
      await expect(loadLmsConnections(path)).resolves.toEqual([connection]);

      await chmod(path, 0o644);
      const error = await loadLmsConnections(path).catch((caught: unknown) => caught);
      expect(String(error)).toContain("Morrow could not load the saved learning-platform connections.");
      expect(String(error)).not.toContain(token);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
