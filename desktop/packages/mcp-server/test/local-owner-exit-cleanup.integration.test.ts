import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, it, vi } from "vitest";

type OwnerIdentity = { pid: number; nonce: string };

async function readOwnerDescriptor(path: string, read = (file: string) => readFile(file, "utf8")): Promise<OwnerIdentity | null> {
  try {
    const owner = JSON.parse(await read(path)) as OwnerIdentity;
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 1
      || typeof owner.nonce !== "string" || !owner.nonce) throw new Error("Invalid local owner descriptor");
    return owner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function terminateMatchingOwner(fresh: OwnerIdentity, owner: OwnerIdentity,
  kill: (pid: number, signal: NodeJS.Signals) => unknown = process.kill): boolean {
  if (fresh.pid !== owner.pid || fresh.nonce !== owner.nonce) return false;
  try {
    kill(owner.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  return true;
}

it("descriptor cleanup tolerates only an atomic read's missing-file result", async () => {
  const disappeared = vi.fn().mockRejectedValue(Object.assign(new Error("removed during shutdown"), { code: "ENOENT" }));
  await expect(readOwnerDescriptor("owner.json", disappeared)).resolves.toBeNull();
  expect(disappeared).toHaveBeenCalledExactlyOnceWith("owner.json");
  const owner = { pid: 42, nonce: "owned" };
  await expect(readOwnerDescriptor("owner.json", async () => JSON.stringify(owner))).resolves.toEqual(owner);
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  await expect(readOwnerDescriptor("owner.json", async () => { throw denied; })).rejects.toBe(denied);
  await expect(readOwnerDescriptor("owner.json", async () => "not JSON")).rejects.toBeInstanceOf(SyntaxError);
  for (const malformed of ["null", "{}", '{"pid":42,"nonce":""}']) {
    await expect(readOwnerDescriptor("owner.json", async () => malformed)).rejects.toThrow("Invalid local owner descriptor");
  }
});

it("owner termination preserves identity and tolerates only an already-exited process", () => {
  const owner = { pid: 42, nonce: "owned" };
  const disappeared = vi.fn(() => { throw Object.assign(new Error("already exited"), { code: "ESRCH" }); });
  expect(terminateMatchingOwner(owner, owner, disappeared)).toBe(true);
  expect(disappeared).toHaveBeenCalledExactlyOnceWith(owner.pid, "SIGTERM");
  const kill = vi.fn();
  expect(terminateMatchingOwner({ ...owner, pid: 43 }, owner, kill)).toBe(false);
  expect(terminateMatchingOwner({ ...owner, nonce: "foreign" }, owner, kill)).toBe(false);
  expect(kill).not.toHaveBeenCalled();
  const denied = Object.assign(new Error("permission denied"), { code: "EPERM" });
  expect(() => terminateMatchingOwner(owner, owner, () => { throw denied; })).toThrow(denied);
});

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
  let owner: OwnerIdentity | null = null;
  try {
    await client.connect(transport);
    await expect(client.callTool({ name: "morrow_health", arguments: {} })).resolves.toMatchObject({ structuredContent: { schema: "morrow.health.v1" } });
    owner = JSON.parse(await readFile(ownerPath, "utf8")) as OwnerIdentity;
    expect(Number.isSafeInteger(owner.pid) && owner.pid > 1).toBe(true);
    await client.close();
    await transport.close();
    const fresh = await readOwnerDescriptor(ownerPath);
    if (fresh) {
      expect(fresh.pid).toBe(owner.pid);
      expect(fresh.nonce).toBe(owner.nonce);
      terminateMatchingOwner(fresh, owner);
    }
    const deadline = Date.now() + 15_000;
    while (!existsSync(receipt) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    const result = JSON.parse(await readFile(receipt, "utf8"));
    if (process.env.MORROW_QA_EVIDENCE) await writeFile(process.env.MORROW_QA_EVIDENCE, JSON.stringify(result, null, 2) + "\n");
    expect(result).toEqual({ schema: "morrow.owner-exit-cleanup.e2e.v1", observerSawOwnerCleanup: true, prepared: true, directoryRecreated: false });
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    if (owner) {
      const fresh = await readOwnerDescriptor(ownerPath);
      if (fresh) terminateMatchingOwner(fresh, owner);
    }
    await rm(directory, { recursive: true, force: true });
    await rm(evidence, { recursive: true, force: true });
  }
}, 30_000);
