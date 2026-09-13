import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSourceCatalog } from "@morrow/gateway-core";
import { LEGACY_BRIDGE_MAX_CATALOG_BYTES, loadLegacyBridgeConfig } from "../src/config.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function environment(catalogPath: string): NodeJS.ProcessEnv {
  return {
    MORROW_LEGACY_CATALOG_PATH: catalogPath,
    MORROW_LEGACY_EXPECTED_REVISION: "7".repeat(40),
    MORROW_LEGACY_BRIDGE_TOKEN: "t".repeat(40),
  };
}

async function fixture(): Promise<{ directory: string; catalogPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "morrow-legacy-config-"));
  directories.push(directory);
  const catalogPath = join(directory, "catalog.json");
  const catalog = buildSourceCatalog({
    id: "morrow-legacy",
    label: "Morrow legacy",
    kind: "donor-export",
    repository: "example-org/morrow-legacy-source",
    revision: "7".repeat(40),
  }, []);
  await writeFile(catalogPath, JSON.stringify(catalog));
  return { directory, catalogPath };
}

describe("legacy Bridge configuration", () => {
  it("loads one stable bounded regular source catalog", async () => {
    const { catalogPath } = await fixture();
    const config = await loadLegacyBridgeConfig(environment(catalogPath));
    expect(config.catalogPath).toBe(catalogPath);
    expect(config.sourceCatalog.source.id).toBe("morrow-legacy");
  });

  it("refuses a linked or oversized catalog before parsing it", async () => {
    const { directory, catalogPath } = await fixture();
    const linkedPath = join(directory, "linked.json");
    await symlink(catalogPath, linkedPath);
    await expect(loadLegacyBridgeConfig(environment(linkedPath))).rejects.toThrow(/stable regular file/u);

    const oversizedPath = join(directory, "oversized.json");
    await writeFile(oversizedPath, "{");
    await truncate(oversizedPath, LEGACY_BRIDGE_MAX_CATALOG_BYTES + 1);
    await expect(loadLegacyBridgeConfig(environment(oversizedPath))).rejects.toThrow(/no larger than 16 MiB/u);
  });

  it.skipIf(process.platform === "win32")("refuses a named pipe without waiting for a writer", async () => {
    const { directory } = await fixture();
    const pipePath = join(directory, "catalog.pipe");
    const made = spawnSync("mkfifo", [pipePath]);
    expect(made.status).toBe(0);
    const startedAt = Date.now();
    await expect(loadLegacyBridgeConfig(environment(pipePath))).rejects.toThrow(/stable regular file/u);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});
