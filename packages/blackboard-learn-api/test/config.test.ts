import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveBlackboardSourceBindingId } from "../src/binding.js";
import { loadBlackboardLearnConfig } from "../src/config.js";

const REVISION = "8c751fc3-ecf9-4558-b86b-d97a34e93295";
const created: string[] = [];
const originalHome = process.env.HOME;
// The real home directory's ancestor chain is private on every platform this
// project ships on. The OS temp directory's is not: Linux's /tmp is world
// writable by design, so a fixture anchored there fails the same outside-home
// ancestor walk production code correctly enforces. Anchoring ordinary
// fixtures under the real home keeps them inside its bounded, symlink-checked
// trust root instead, which is what "an ordinary saved configuration" means.
const realHome = resolve(originalHome || homedir());
afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function configuration(binding?: string): Promise<{ readonly path: string; readonly environment: NodeJS.ProcessEnv }> {
  const directory = await mkdtemp(join(realHome, ".morrow-blackboard-config-test-"));
  created.push(directory);
  const path = join(directory, "blackboard.json");
  await writeFile(path, JSON.stringify({
    schema: "morrow.blackboard-learn.config.v1",
    tenants: [{
      id: "school", baseUrl: "https://learn.example.edu", applicationKey: "application-key", credentialRef: "environment", principalId: "_11_1",
      courseBindings: [{ courseId: "_22_1", ...(binding ? { sourceBindingId: binding } : {}) }],
    }],
  }), { mode: 0o600 });
  return { path, environment: { MORROW_BLACKBOARD_CONFIG: path, MORROW_BLACKBOARD_SECRET_SCHOOL: "server-secret" } };
}

describe("Blackboard Learn configuration", () => {
  it("derives a stable source binding from the normalized tenant, principal, and course without returning the secret", async () => {
    const input = await configuration();
    const tenants = await loadBlackboardLearnConfig(input.environment);
    expect(tenants).toHaveLength(1);
    expect(tenants[0]).toMatchObject({
      id: "school",
      courseBindings: [{ courseId: "_22_1", sourceBindingId: deriveBlackboardSourceBindingId("https://learn.example.edu", "_11_1", "_22_1") }],
    });
    expect(JSON.stringify(tenants[0]?.courseBindings)).not.toContain("server-secret");
  });

  it("reads the optional principal verification mode and refuses an unknown one", async () => {
    const input = await configuration();
    // An absent mode is the account check, which is what an existing setup file has.
    await expect(loadBlackboardLearnConfig(input.environment)).resolves.toMatchObject([{ principalVerification: "self" }]);
    const document = (mode: unknown) => JSON.stringify({
      schema: "morrow.blackboard-learn.config.v1",
      tenants: [{
        id: "school", baseUrl: "https://learn.example.edu", applicationKey: "application-key", credentialRef: "environment",
        principalId: "_11_1", principalVerification: mode, courseBindings: [{ courseId: "_22_1" }],
      }],
    });
    await writeFile(input.path, document("membership-only"), { mode: 0o600 });
    await expect(loadBlackboardLearnConfig(input.environment)).resolves.toMatchObject([{ principalVerification: "membership-only" }]);
    await writeFile(input.path, document("none"), { mode: 0o600 });
    await expect(loadBlackboardLearnConfig(input.environment)).rejects.toThrow("principal verification is invalid");
  });

  it("refuses a configured source binding that claims another tenant principal or course", async () => {
    const input = await configuration("blackboard:claimed-by-another-account");
    await expect(loadBlackboardLearnConfig(input.environment)).rejects.toThrow("does not match its tenant principal and course");
  });

  it("reads a fixed private credential file only after the shared private-file gate accepts it", async () => {
    const input = await configuration();
    const home = await mkdtemp(join(tmpdir(), "morrow-blackboard-home-"));
    created.push(home); process.env.HOME = home;
    const secretDirectory = join(home, ".morrow", "credentials", "blackboard");
    await mkdir(secretDirectory, { recursive: true, mode: 0o700 });
    const secretPath = join(secretDirectory, "school.secret");
    await writeFile(secretPath, JSON.stringify({
      schema: "morrow.blackboard-learn.credential.v1", credentialRevision: REVISION, applicationSecret: "file-secret",
    }), { mode: 0o600 });
    const fileDocument = JSON.stringify({
      schema: "morrow.blackboard-learn.config.v1",
      tenants: [{ id: "school", baseUrl: "https://learn.example.edu", applicationKey: "application-key", credentialRef: "file", credentialRevision: REVISION, principalId: "_11_1", courseBindings: [{ courseId: "_22_1" }] }],
    });
    await writeFile(input.path, fileDocument, { mode: 0o600 });
    await expect(loadBlackboardLearnConfig({ MORROW_BLACKBOARD_CONFIG: input.path })).resolves.toMatchObject([{ clientSecret: "file-secret" }]);
    await chmod(secretPath, 0o644);
    await expect(loadBlackboardLearnConfig({ MORROW_BLACKBOARD_CONFIG: input.path })).rejects.toThrow("credential access is not private");
  });

  it("refuses missing or mismatched file credential revisions before any Blackboard network request", async () => {
    const input = await configuration();
    const home = await mkdtemp(join(tmpdir(), "morrow-blackboard-home-"));
    created.push(home); process.env.HOME = home;
    const secretDirectory = join(home, ".morrow", "credentials", "blackboard");
    await mkdir(secretDirectory, { recursive: true, mode: 0o700 });
    const secretPath = join(secretDirectory, "school.secret");
    const fileDocument = {
      schema: "morrow.blackboard-learn.config.v1",
      tenants: [{ id: "school", baseUrl: "https://learn.example.edu", applicationKey: "application-key", credentialRef: "file", credentialRevision: REVISION, principalId: "_11_1", courseBindings: [{ courseId: "_22_1" }] }],
    };
    await writeFile(input.path, JSON.stringify(fileDocument), { mode: 0o600 });
    let networkRequests = 0;
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = (async () => { networkRequests += 1; throw new Error("network must not be called"); }) as typeof fetch;
    try {
      await expect(loadBlackboardLearnConfig({ MORROW_BLACKBOARD_CONFIG: input.path })).rejects.toThrow();
      await writeFile(secretPath, JSON.stringify({
        schema: "morrow.blackboard-learn.credential.v1", credentialRevision: "bb757a27-a3e6-4f04-8c3e-c58bdaf62e79", applicationSecret: "file-secret",
      }), { mode: 0o600 });
      await expect(loadBlackboardLearnConfig({ MORROW_BLACKBOARD_CONFIG: input.path })).rejects.toThrow("does not match its configuration");
      expect(networkRequests).toBe(0);
    } finally {
      globalThis.fetch = fetchBefore;
    }
  });

  it("refuses a symlinked credential ancestor under the home root before any network request", async () => {
    const input = await configuration();
    const home = await mkdtemp(join(tmpdir(), "morrow-blackboard-home-"));
    const outside = await mkdtemp(join(tmpdir(), "morrow-blackboard-outside-"));
    created.push(home, outside); process.env.HOME = home;
    const linkedCredentials = join(home, ".morrow", "credentials");
    const secretDirectory = join(outside, "blackboard");
    await mkdir(join(home, ".morrow"), { recursive: true, mode: 0o700 });
    await mkdir(secretDirectory, { recursive: true, mode: 0o700 });
    await symlink(outside, linkedCredentials);
    await writeFile(join(secretDirectory, "school.secret"), JSON.stringify({
      schema: "morrow.blackboard-learn.credential.v1", credentialRevision: REVISION, applicationSecret: "file-secret",
    }), { mode: 0o600 });
    await writeFile(input.path, JSON.stringify({
      schema: "morrow.blackboard-learn.config.v1",
      tenants: [{ id: "school", baseUrl: "https://learn.example.edu", applicationKey: "application-key", credentialRef: "file", credentialRevision: REVISION, principalId: "_11_1", courseBindings: [{ courseId: "_22_1" }] }],
    }), { mode: 0o600 });
    let networkRequests = 0;
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = (async () => { networkRequests += 1; throw new Error("network must not be called"); }) as typeof fetch;
    try {
      await expect(loadBlackboardLearnConfig({ MORROW_BLACKBOARD_CONFIG: input.path })).rejects.toThrow("credential access is not private");
      expect(networkRequests).toBe(0);
    } finally {
      globalThis.fetch = fetchBefore;
    }
  });

  it("refuses an insecure or linked configuration before it can select a Blackboard OAuth destination", async () => {
    const input = await configuration();
    await chmod(input.path, 0o644);
    await expect(loadBlackboardLearnConfig(input.environment)).rejects.toThrow("configuration access is not private");
    await chmod(input.path, 0o600);
    const linked = `${input.path}.linked`;
    await symlink(input.path, linked);
    await expect(loadBlackboardLearnConfig({ ...input.environment, MORROW_BLACKBOARD_CONFIG: linked }))
      .rejects.toThrow("configuration access is not private");
  });

  it("refuses an oversized configuration before parsing or contacting Blackboard", async () => {
    const input = await configuration();
    await writeFile(input.path, " ".repeat(1_048_577), { mode: 0o600 });
    let networkRequests = 0;
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = (async () => { networkRequests += 1; throw new Error("network must not be called"); }) as typeof fetch;
    try {
      await expect(loadBlackboardLearnConfig(input.environment)).rejects.toThrow("configuration is invalid");
      expect(networkRequests).toBe(0);
    } finally {
      globalThis.fetch = fetchBefore;
    }
  });
});
