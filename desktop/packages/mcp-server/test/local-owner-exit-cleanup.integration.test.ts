import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, it } from "vitest";

it("a fully closed local owner does not recreate removed state from its exit listener", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "morrow-exit-cleanup-")));
  const evidence = await realpath(await mkdtemp(join(tmpdir(), "morrow-exit-evidence-")));
  const receipt = join(evidence, "receipt.json");
  const configPath = join(directory, "morrow.upstreams.json");
  const journalPath = join(directory, "gateway.sqlite3");
  const ownerPath = `${journalPath}.local-owner.json`;
  await writeFile(configPath, JSON.stringify({
    schema: "morrow.upstreams.v1", profile: "private-full", toolSurface: "full",
    sourcePolicy: { requireAttestation: false },
    upstreams: [{ id: "morrow-legacy", label: "Fixture", kind: "mcp-stdio", command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url))], env: { FAKE_SOURCE: "morrow-legacy" }, priority: 1, required: true, enabled: true }],
    filters: { excludePrefixes: [], excludeNames: [] }, operationJournal: { path: journalPath },
    privacy: { canvasOrigin: "local", account: "local-account", principal: "local-principal", learnerVaultPath: join(directory, "learner-vault.json") }, maxCatalogTools: 20,
  }));
  const client = new Client({ name: "exit-cleanup-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))], cwd: directory,
    env: { ...getDefaultEnvironment(), MORROW_UPSTREAMS_FILE: configPath,
      NODE_OPTIONS: `--import=${new URL("./fixtures/owner-exit-observer.mjs", import.meta.url).href}`,
      MORROW_QA_OWNER_EXIT_ROOT: directory, MORROW_QA_OWNER_EXIT_RECEIPT: receipt }, stderr: "pipe" });
  let owner: { pid: number; nonce: string } | null = null;
  try {
    await client.connect(transport);
    await expect(client.callTool({ name: "morrow_health", arguments: {} })).resolves.toMatchObject({ structuredContent: { schema: "morrow.health.v1" } });
    owner = JSON.parse(await readFile(ownerPath, "utf8")) as { pid: number; nonce: string };
    expect(Number.isSafeInteger(owner.pid) && owner.pid > 1).toBe(true);
    await client.close();
    await transport.close();
    if (existsSync(ownerPath)) {
      const fresh = JSON.parse(await readFile(ownerPath, "utf8")) as typeof owner;
      expect(fresh?.pid).toBe(owner.pid);
      expect(fresh?.nonce).toBe(owner.nonce);
      process.kill(owner.pid, "SIGTERM");
    }
    const deadline = Date.now() + 15_000;
    while (!existsSync(receipt) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    const result = JSON.parse(await readFile(receipt, "utf8"));
    if (process.env.MORROW_QA_EVIDENCE) await writeFile(process.env.MORROW_QA_EVIDENCE, JSON.stringify(result, null, 2) + "\n");
    expect(result).toEqual({ schema: "morrow.owner-exit-cleanup.e2e.v1", observerSawOwnerCleanup: true, prepared: true, directoryRecreated: false });
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    if (owner && existsSync(ownerPath)) {
      const fresh = JSON.parse(await readFile(ownerPath, "utf8")) as typeof owner;
      if (fresh?.pid === owner.pid && fresh?.nonce === owner.nonce) {
        try { process.kill(owner.pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }
    await rm(directory, { recursive: true, force: true });
    await rm(evidence, { recursive: true, force: true });
  }
}, 30_000);
