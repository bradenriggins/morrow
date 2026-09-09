import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCanvasConnectorConfig } from "../src/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

async function statePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "morrow-connector-config-"));
  temporaryDirectories.push(directory);
  return join(directory, "state.json");
}

describe("Canvas connector config", () => {
  it("creates one stable token across concurrent first loads", async () => {
    const path = await statePath();
    const configs = await Promise.all(Array.from({ length: 20 }, async () => await loadCanvasConnectorConfig({
      MORROW_CANVAS_CONNECTOR_STATE: path,
    }, process.cwd())));

    expect(new Set(configs.map((config) => config.token))).toHaveLength(1);
    const persisted = JSON.parse(await readFile(path, "utf8")) as { token: string; allowedExtensionIds: string[] };
    expect(persisted.token).toBe(configs[0]!.token);
    expect(persisted.allowedExtensionIds).toEqual([]);
  });

  it("preserves every extension approved concurrently", async () => {
    const path = await statePath();
    const configs = await Promise.all(Array.from({ length: 8 }, async () => await loadCanvasConnectorConfig({
      MORROW_CANVAS_CONNECTOR_STATE: path,
    }, process.cwd())));
    const extensionIds = "abcdefghijklmnop".split("").map((character) => character.repeat(32));

    await Promise.all(extensionIds.map(async (extensionId, index) => {
      await configs[index % configs.length]!.approveExtensionId(extensionId);
    }));

    const persisted = JSON.parse(await readFile(path, "utf8")) as { allowedExtensionIds: string[] };
    expect(persisted.allowedExtensionIds).toEqual(extensionIds);
  });

  it("refuses malformed extension ids before changing state", async () => {
    const path = await statePath();
    const config = await loadCanvasConnectorConfig({ MORROW_CANVAS_CONNECTOR_STATE: path }, process.cwd());
    await expect(config.approveExtensionId("not-a-chrome-extension-id")).rejects.toThrow("connector extension ids are invalid");
    const persisted = JSON.parse(await readFile(path, "utf8")) as { allowedExtensionIds: string[] };
    expect(persisted.allowedExtensionIds).toEqual([]);
  });
});
