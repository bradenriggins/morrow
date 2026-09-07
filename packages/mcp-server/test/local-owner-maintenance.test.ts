import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LocalOwnerMaintenanceClientError,
  clearDeadLocalOwnerMaintenanceLease,
  createLocalOwnerMaintenanceLease,
  localOwnerMaintenanceMatches,
  localOwnerMaintenancePath,
  readLocalOwnerMaintenanceLease,
  recoverExactLocalOwnerMaintenanceLease,
  removeExactLocalOwnerMaintenanceLease,
  requestLocalOwnerMaintenance,
  writeLocalOwnerMaintenanceLease,
  type LocalOwnerIdentity,
} from "../src/local-owner-maintenance.js";
import { localOwnerSidecarAccessAccepted } from "../src/local-owner-sidecar-access.js";

function owner(journalPath: string, overrides: Partial<LocalOwnerIdentity> = {}): LocalOwnerIdentity {
  return {
    nonce: randomUUID(),
    pid: 4_201,
    port: 31_337,
    token: "morrow-local-owner-maintenance-token-1234567890",
    journalPath,
    configDigest: "a".repeat(64),
    ...overrides,
  };
}

async function directory(): Promise<{ root: string; journalPath: string; workspaceRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "morrow-local-owner-maintenance-"));
  const workspace = join(root, "Materials");
  await (await import("node:fs/promises")).mkdir(workspace, { recursive: true });
  const workspaceRoot = await realpath(workspace);
  return { root, journalPath: join(root, "gateway.sqlite3"), workspaceRoot };
}

describe("local owner maintenance lease", () => {
  it("requires a private Windows ACL for a sidecar and its containing State directory", async () => {
    const fixture = await directory();
    const sidecar = `${fixture.journalPath}.local-owner.json`;
    try {
      await writeFile(sidecar, "sidecar\n", { mode: 0o600 });
      expect(localOwnerSidecarAccessAccepted(sidecar, 0o100600, { platform: "darwin" })).toBe(true);
      expect(localOwnerSidecarAccessAccepted(sidecar, 0o100666, { platform: "darwin" })).toBe(false);
      const classified: string[] = [];
      expect(localOwnerSidecarAccessAccepted(sidecar, 0o100666, {
        platform: "win32",
        classifyWindowsAcl: (candidate) => {
          classified.push(candidate);
          return "private";
        },
      })).toBe(true);
      expect(classified).toEqual([sidecar, fixture.root]);
      expect(localOwnerSidecarAccessAccepted(sidecar, 0o100666, {
        platform: "win32",
        classifyWindowsAcl: (candidate) => candidate === sidecar ? "additional_principal_access_allow" : "private",
      })).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked owner descriptor before a private request", async () => {
    const fixture = await directory();
    const descriptorPath = `${fixture.journalPath}.local-owner.json`;
    const target = join(fixture.root, "owner-descriptor-target.json");
    try {
      await writeFile(target, `${JSON.stringify({
        schema: "morrow.local-owner.v1",
        nonce: randomUUID(),
        pid: 4_301,
        port: 31_337,
        token: "morrow-local-owner-maintenance-symlink-token-12345",
        journalPath: fixture.journalPath,
        configDigest: "e".repeat(64),
        startedAt: new Date().toISOString(),
      })}\n`, { mode: 0o600 });
      await symlink(target, descriptorPath);
      let called = false;
      await expect(requestLocalOwnerMaintenance({
        action: "acquire",
        journalPath: fixture.journalPath,
        holderPid: 4_401,
        monitorProxyPid: 4_402,
        workspaceRoot: fixture.workspaceRoot,
      }, (async () => {
        called = true;
        return new Response("unexpected", { status: 200 });
      }) as typeof fetch)).rejects.toMatchObject<Partial<LocalOwnerMaintenanceClientError>>({
        code: "local_owner_unavailable",
      });
      expect(called).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("creates one private bound lease and will not release it with another lease secret", async () => {
    const fixture = await directory();
    try {
      const first = createLocalOwnerMaintenanceLease(owner(fixture.journalPath), {
        holderPid: 5_001,
        monitorProxyPid: 5_002,
        workspaceRoot: fixture.workspaceRoot,
      });
      const competing = createLocalOwnerMaintenanceLease(owner(fixture.journalPath), {
        holderPid: 5_003,
        monitorProxyPid: 5_004,
        workspaceRoot: fixture.workspaceRoot,
      });
      writeLocalOwnerMaintenanceLease(first);
      expect(() => writeLocalOwnerMaintenanceLease(competing)).toThrow();
      expect((await stat(localOwnerMaintenancePath(fixture.journalPath))).mode & 0o077).toBe(0);
      expect(readLocalOwnerMaintenanceLease(fixture.journalPath)).toMatchObject({
        leaseId: first.leaseId,
        holderPid: 5_001,
        monitorProxyPid: 5_002,
        recovery: false,
      });
      expect(removeExactLocalOwnerMaintenanceLease(fixture.journalPath, first.leaseId, competing.leaseToken)).toBe(false);
      expect(readLocalOwnerMaintenanceLease(fixture.journalPath)?.leaseId).toBe(first.leaseId);
      expect(removeExactLocalOwnerMaintenanceLease(fixture.journalPath, first.leaseId, first.leaseToken)).toBe(true);
      expect(readLocalOwnerMaintenanceLease(fixture.journalPath)).toBeNull();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rotates only an exact dead-holder lease inside its live owner, then clears it after that owner exits", async () => {
    const fixture = await directory();
    try {
      const initialOwner = owner(fixture.journalPath);
      const initial = createLocalOwnerMaintenanceLease(initialOwner, {
        holderPid: 5_101,
        monitorProxyPid: 5_102,
        workspaceRoot: fixture.workspaceRoot,
      });
      writeLocalOwnerMaintenanceLease(initial);
      const recovered = recoverExactLocalOwnerMaintenanceLease(initialOwner, {
        holderPid: 5_201,
        workspaceRoot: fixture.workspaceRoot,
        previousLeaseId: initial.leaseId,
        previousLeaseToken: initial.leaseToken,
        processAlive: (pid) => pid === 5_201,
      });
      expect(recovered).toMatchObject({ holderPid: 5_201, recovery: false, ownerNonce: initial.ownerNonce });
      expect(recovered?.leaseId).not.toBe(initial.leaseId);
      expect(readLocalOwnerMaintenanceLease(fixture.journalPath)?.leaseId).toBe(recovered?.leaseId);
      expect(recoverExactLocalOwnerMaintenanceLease(initialOwner, {
        holderPid: 5_202,
        workspaceRoot: fixture.workspaceRoot,
        previousLeaseId: initial.leaseId,
        previousLeaseToken: initial.leaseToken,
        processAlive: () => false,
      })).toBeNull();
      // The current monitor is not a durable release credential. Commit uses
      // the exact app holder and rotated lease after the old owner exits.
      expect(localOwnerMaintenanceMatches(
        recovered!,
        initialOwner,
        5_201,
        fixture.workspaceRoot,
        recovered!.leaseId,
        recovered!.leaseToken,
      )).toBe(true);
      expect(clearDeadLocalOwnerMaintenanceLease(fixture.journalPath, {
        holderPid: 5_201,
        workspaceRoot: fixture.workspaceRoot,
        processAlive: (pid) => pid === 5_201,
      })).toBe(true);
      expect(readLocalOwnerMaintenanceLease(fixture.journalPath)).toBeNull();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("binds the private main request to its descriptor, app PID, monitor PID, and canonical workspace", async () => {
    const fixture = await directory();
    try {
      const descriptorPath = `${fixture.journalPath}.local-owner.json`;
      const endpoint = {
        schema: "morrow.local-owner.v1",
        nonce: randomUUID(),
        pid: 6_001,
        port: 31_338,
        token: "morrow-local-owner-maintenance-endpoint-token-12345",
        journalPath: fixture.journalPath,
        configDigest: "b".repeat(64),
        startedAt: new Date().toISOString(),
      };
      await writeFile(descriptorPath, `${JSON.stringify(endpoint)}\n`, { mode: 0o600 });
      await chmod(descriptorPath, 0o600);
      let captured: { url: string; init: RequestInit } | null = null;
      const result = await requestLocalOwnerMaintenance({
        action: "acquire",
        journalPath: fixture.journalPath,
        holderPid: 6_101,
        monitorProxyPid: 6_102,
        workspaceRoot: fixture.workspaceRoot,
      }, (async (url, init) => {
        captured = { url: String(url), init: init! };
        return new Response(JSON.stringify({
          schema: "morrow.local-owner-maintenance.v1",
          status: "held",
          leaseId: randomUUID(),
          leaseToken: "morrow-local-owner-maintenance-lease-token-123456",
          ownerNonce: endpoint.nonce,
          holderPid: 6_101,
          monitorProxyPid: 6_102,
        }), { status: 200 });
      }) as typeof fetch);
      expect(result.status).toBe("held");
      expect(captured?.url).toBe("http://127.0.0.1:31338/morrow-maintenance/v1");
      expect(captured?.init.headers).toMatchObject({
        authorization: `Bearer ${endpoint.token}`,
        "x-morrow-proxy-pid": "6101",
        "x-morrow-workspace": Buffer.from(fixture.workspaceRoot).toString("base64url"),
      });
      expect(JSON.parse(String(captured?.init.body))).toEqual({
        schema: "morrow.local-owner-maintenance.request.v1",
        action: "acquire",
        holderPid: 6_101,
        monitorProxyPid: 6_102,
      });
      expect(JSON.parse(await readFile(descriptorPath, "utf8"))).toMatchObject({ nonce: endpoint.nonce });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses a malformed or noncanonical maintenance response", async () => {
    const fixture = await directory();
    try {
      const descriptorPath = `${fixture.journalPath}.local-owner.json`;
      await writeFile(descriptorPath, `${JSON.stringify({
        schema: "morrow.local-owner.v1",
        nonce: randomUUID(),
        pid: 7_001,
        port: 31_339,
        token: "morrow-local-owner-maintenance-endpoint-token-67890",
        journalPath: fixture.journalPath,
        configDigest: "c".repeat(64),
        startedAt: new Date().toISOString(),
      })}\n`, { mode: 0o600 });
      await chmod(descriptorPath, 0o600);
      await expect(requestLocalOwnerMaintenance({
        action: "acquire",
        journalPath: fixture.journalPath,
        holderPid: 7_101,
        monitorProxyPid: 7_102,
        workspaceRoot: fixture.workspaceRoot,
      }, (async () => new Response(JSON.stringify({
        schema: "morrow.local-owner-maintenance.v1",
        status: "held",
        leaseId: randomUUID(),
      }), { status: 200 })) as typeof fetch)).rejects.toMatchObject<Partial<LocalOwnerMaintenanceClientError>>({
        code: "local_owner_maintenance_response_invalid",
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("routes the fixed private Bridge status control without a lease or caller-selected source", async () => {
    const fixture = await directory();
    try {
      const descriptorPath = `${fixture.journalPath}.local-owner.json`;
      await writeFile(descriptorPath, `${JSON.stringify({
        schema: "morrow.local-owner.v1",
        nonce: randomUUID(),
        pid: 8_001,
        port: 31_340,
        token: "morrow-local-owner-maintenance-endpoint-token-bridge",
        journalPath: fixture.journalPath,
        configDigest: "d".repeat(64),
        startedAt: new Date().toISOString(),
      })}\n`, { mode: 0o600 });
      await chmod(descriptorPath, 0o600);
      let body: unknown;
      const result = await requestLocalOwnerMaintenance({
        action: "bridge",
        journalPath: fixture.journalPath,
        holderPid: 8_101,
        workspaceRoot: fixture.workspaceRoot,
        control: { action: "status" },
      }, (async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          schema: "morrow.local-owner-maintenance.v1",
          status: "bridge",
          result: { schema: "morrow.bridge.update-status.v1" },
        }), { status: 200 });
      }) as typeof fetch);
      expect(body).toEqual({
        schema: "morrow.local-owner-maintenance.request.v1",
        action: "bridge",
        holderPid: 8_101,
        control: { action: "status" },
      });
      expect(result).toEqual({
        schema: "morrow.local-owner-maintenance.v1",
        status: "bridge",
        result: { schema: "morrow.bridge.update-status.v1" },
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
