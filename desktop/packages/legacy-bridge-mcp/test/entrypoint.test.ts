import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildSourceCatalog } from "@morrow/gateway-core";

let child: ChildProcess | null = null;

afterEach(async () => {
  if (child?.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child!.once("exit", () => resolve()));
  }
  child = null;
});

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test port unavailable");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe("legacy bridge MCP entrypoint", () => {
  it("closes stdio and the loopback listener when its parent input ends", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-legacy-entrypoint-"));
    const revision = "7".repeat(40);
    const catalog = buildSourceCatalog({
      id: "morrow-legacy",
      label: "Morrow legacy",
      kind: "donor-export",
      repository: "example-org/morrow-legacy-source",
      revision,
    }, []);
    const catalogPath = join(directory, "catalog.json");
    const port = await unusedPort();
    await writeFile(catalogPath, JSON.stringify(catalog));
    try {
      child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url))], {
        stdio: ["pipe", "ignore", "pipe"],
        env: {
          ...process.env,
          MORROW_LEGACY_CATALOG_PATH: catalogPath,
          MORROW_LEGACY_EXPECTED_REVISION: revision,
          MORROW_LEGACY_BRIDGE_TOKEN: "t".repeat(40),
          MORROW_LEGACY_BRIDGE_PORT: String(port),
        },
      });
      let stderr = "";
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`entrypoint did not start: ${stderr}`)), 2_000);
        const inspect = () => {
          if (!stderr.includes("[morrow-legacy-bridge] ws://")) return;
          clearTimeout(timeout);
          resolve();
        };
        child!.stderr!.on("data", inspect);
        child!.once("exit", (code) => {
          clearTimeout(timeout);
          reject(new Error(`entrypoint exited before startup with ${code}: ${stderr}`));
        });
      });
      child.stdin!.end();
      const exit = await Promise.race([
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child!.once("exit", (code, signal) => resolve({ code, signal }))),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
      ]);
      expect(exit).toEqual({ code: 0, signal: null });

      const reclaimed = createServer();
      await new Promise<void>((resolve, reject) => reclaimed.listen(port, "127.0.0.1", resolve).once("error", reject));
      await new Promise<void>((resolve) => reclaimed.close(() => resolve()));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
