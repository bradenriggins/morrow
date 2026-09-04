import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSourceCatalog } from "@morrow/gateway-core";
import { StdioMcpUpstream } from "@morrow/upstream-mcp";
import { parseGatewayConfig } from "../src/config.js";
import {
  buildExamplePlatformSshLaunch,
  mapExamplePlatformEnvironment,
} from "../src/meridian-runtime-adapter.js";
import { GatewayRuntime } from "../src/runtime.js";
import { verifyRemoteGitSshSourceAttestation } from "../src/source-attestation.js";

const revision = "7cc052cf2063e1f2492c0ac20aee41ee3a22a10f";
const fixturePath = fileURLToPath(new URL("./fixtures/fake-reconnecting-upstream.mjs", import.meta.url));

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function sourceTruth(directory: string): Promise<{ path: string; fileSha256: string }> {
  const upstream = new StdioMcpUpstream({
    id: "meridian",
    label: "fixture",
    command: process.execPath,
    args: [fixturePath],
  });
  const tools = await upstream.connect();
  await upstream.close();
  const artifact = buildSourceCatalog({
    id: "meridian",
    label: "ExamplePlatform fixture",
    kind: "mcp-stdio",
    repository: "fixture/meridian",
    revision,
    capturedAt: "2026-09-04T12:00:00.000Z",
  }, tools.map((tool) => ({
    ...tool,
    capability: {
      family: "canvas-operation",
      provider: "canvas",
      route: { backend: "meridian" },
    },
  })));
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  const path = join(directory, "meridian.live.json");
  await writeFile(path, bytes);
  return { path, fileSha256: createHash("sha256").update(bytes).digest("hex") };
}

async function fakeSsh(
  directory: string,
  statePrefix: string,
  crashTool = "",
  failStartupOnce = false,
): Promise<string> {
  const path = join(directory, "ssh");
  const startupMarker = `${statePrefix}.startup`;
  const script = [
    "#!/bin/sh",
    "set -eu",
    "test \"$1\" = \"-T\"",
    "if printf '%s' \"$3\" | grep -q '^sh -s --'; then",
    `  printf '%s\\nclean\\n' ${shellQuote(revision)}`,
    "  exit 0",
    "fi",
    `printf '%s\\n' "$3" >> ${shellQuote(`${statePrefix}.commands`)}`,
    ...(failStartupOnce
      ? [
          `if test ! -f ${shellQuote(startupMarker)}; then`,
          `  : > ${shellQuote(startupMarker)}`,
          "  exit 19",
          "fi",
        ]
      : []),
    `exec env FAKE_STATE_PREFIX=${shellQuote(statePrefix)} FAKE_CRASH_TOOL=${shellQuote(crashTool)} ${shellQuote(process.execPath)} ${shellQuote(fixturePath)}`,
    "",
  ].join("\n");
  await writeFile(path, script, "utf8");
  await chmod(path, 0o755);
  return directory;
}

function config(
  truth: { path: string; fileSha256: string },
  stateDirectory: string,
  edit = false,
) {
  return parseGatewayConfig({
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    sourcePolicy: { requireAttestation: true },
    upstreams: [{
      id: "meridian",
      label: "ExamplePlatform fixture",
      kind: "meridian-ssh",
      host: "example-lms-vps",
      remoteRoot: "/remote/frozen-meridian",
      serverPath: "scripts/team/mcp/meridian_server.py",
      repository: "fixture/meridian",
      revision,
      attestation: {
        kind: "remote-git-ssh",
        host: "example-lms-vps",
        root: "/remote/frozen-meridian",
        expectedRevision: revision,
        requireTrackedClean: true,
      },
      catalogTruth: truth,
      runtimeProfile: edit
        ? {
            kind: "private-runtime",
            profileId: "morrow-private",
            environment: "test",
            localOperator: "morrow-operator",
            sessionId: "runtime",
            stateDirectory: "/tmp/morrow-private",
            mode: "edit",
          }
        : {
            kind: "catalog-hermetic",
            profileId: "morrow-catalog",
            environment: "test",
            localOperator: "morrow-catalog",
            sessionId: "catalog-list",
            stateDirectory: "/tmp/morrow-catalog",
            mode: "read-only",
          },
      supervision: {
        startupAttempts: 2,
        reconnectAttempts: 2,
        initialBackoffMs: 5,
        maxBackoffMs: 10,
      },
      outputPrivacy: {
        canvas_page_get: {
          allowedFields: ["course_id"],
          dataClass: "course",
          maxRecords: 10,
          maxBytes: 2_000,
          freeText: "allow",
          learnerTokens: false,
          artifactInspection: "deny",
        },
        canvas_page_update: {
          allowedFields: ["course_id", "updated"],
          dataClass: "course",
          maxRecords: 10,
          maxBytes: 2_000,
          freeText: "allow",
          learnerTokens: false,
          artifactInspection: "deny",
        },
      },
    }],
    filters: { excludePrefixes: ["mindtap_", "connect_"], excludeNames: [] },
    operationJournal: { path: stateDirectory },
    maxCatalogTools: 10,
  });
}

describe("ExamplePlatform SSH runtime adapter", () => {
  it("maps generic profile fields and pins ssh -T launch", () => {
    const mapped = mapExamplePlatformEnvironment({
      host: "example-lms-vps",
      remoteRoot: "/remote/donor",
      serverPath: "scripts/team/mcp/meridian_server.py",
      runtimeProfile: {
        kind: "private-runtime",
        profileId: "morrow-private",
        environment: "production",
        localOperator: "local-operator",
        sessionId: "session-1",
        stateDirectory: "/remote/state",
        mode: "edit",
        canvasConnection: { kind: "session-path", path: "/remote/session.json" },
        courseScope: { courseId: "101" },
        operation: { id: "operation-1", taskContractDigest: "a".repeat(64) },
        learnerVault: { vaultId: "c_0123456789abcdef" },
      },
    });
    expect(mapped).toMatchObject({
      CHCP_INSTANCE_NAME: "morrow-private",
      CHCP_ENVIRONMENT: "production",
      CHCP_TEAM_SESSION_USER: "local-operator",
      CHCP_TEAM_CONVERSATION_ID: "session-1",
      CHCP_TEAM_COURSE_ID: "101",
      CHCP_TEAM_JOB_ID: "operation-1",
      CHCP_TEAM_TASK_CONTRACT_DIGEST: "a".repeat(64),
      CHCP_TEAM_VAULT_ID: "c_0123456789abcdef",
      CHCP_TEAM_OPERATION_MODE: "edit",
      CANVAS_SESSION_PATH: "/remote/session.json",
    });
    expect(mapped).not.toHaveProperty("CHCP_READ_ONLY");
    const launch = buildExamplePlatformSshLaunch({
      host: "example-lms-vps",
      remoteRoot: "/remote/donor",
      serverPath: "scripts/team/mcp/meridian_server.py",
      runtimeProfile: {
        kind: "catalog-hermetic",
        profileId: "morrow-catalog",
        environment: "test",
        localOperator: "morrow-catalog",
        sessionId: "catalog-list",
        stateDirectory: "/remote/state",
        mode: "read-only",
      },
    });
    expect(launch.command).toBe("ssh");
    expect(launch.args.slice(0, 2)).toEqual(["-T", "example-lms-vps"]);
    expect(launch.args[2]).toContain("exec env -i");
    expect(launch.meridianEnvironment.CHCP_READ_ONLY).toBe("1");
    expect(launch.meridianEnvironment).toMatchObject({
      CHCP_TEAM_JOB_ID: "catalog-list",
      CHCP_OPERATOR_JOB_ID: "catalog-list",
      CHCP_JOB_SCRATCH_DIR: "/remote/state/job-scratch/morrow-catalog/catalog-list",
    });
  });

  it("attests remote Git without returning or echoing the remote root", () => {
    const root = "/private/remote/donor";
    const evidence = verifyRemoteGitSshSourceAttestation(
      "meridian",
      "fixture/meridian",
      {
        kind: "remote-git-ssh",
        host: "example-lms-vps",
        root,
        expectedRevision: revision,
        requireTrackedClean: true,
      },
      () => new Date("2026-09-04T12:00:00.000Z"),
      (command, args, options) => {
        expect(command).toBe("ssh");
        expect(args.slice(0, 2)).toEqual(["-T", "example-lms-vps"]);
        expect(options.input).not.toContain(root);
        return `${revision}\nclean\n`;
      },
    );
    expect(evidence).toMatchObject({
      kind: "remote-git-ssh",
      actualRevision: revision,
      trackedClean: true,
    });
    expect(JSON.stringify(evidence)).not.toContain(root);
    expect(() => verifyRemoteGitSshSourceAttestation(
      "meridian",
      undefined,
      {
        kind: "remote-git-ssh",
        host: "example-lms-vps",
        root,
        expectedRevision: revision,
        requireTrackedClean: true,
      },
      () => new Date(),
      () => `${revision}\ndirty\n`,
    )).toThrow(/tracked worktree changes/);
  });

  it("retries startup and a disconnected safe read, with truth and generation receipts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-meridian-read-"));
    const previousPath = process.env.PATH;
    try {
      const truth = await sourceTruth(directory);
      const statePrefix = join(directory, "read");
      await fakeSsh(directory, statePrefix, "canvas_page_get", true);
      process.env.PATH = `${directory}:${previousPath || ""}`;
      const runtime = await GatewayRuntime.connect(config(truth, ":memory:"), { journalPath: ":memory:" });
      try {
        expect(runtime.catalog.tools.map((tool) => tool.publicName))
          .toEqual(["canvas_page_get", "canvas_page_update"]);
        const result = await runtime.call("canvas_page_get", { course_id: "101" });
        expect(result.isError).not.toBe(true);
        expect((await readFile(`${statePrefix}.calls`, "utf8")).trim().split("\n"))
          .toEqual(["canvas_page_get", "canvas_page_get"]);
        expect(runtime.health().sources[0]).toMatchObject({
          connected: true,
          toolCount: 4,
          expectedToolCount: 4,
          catalogAttested: true,
          connectionGeneration: 2,
          reconnect: { state: "idle", startupAttempts: 2 },
          sourceAttestation: { actualRevision: revision, trackedClean: true },
          catalogTruth: {
            verified: true,
            totalToolCount: 4,
            eligibleToolCount: 2,
            heldToolCount: 2,
          },
        });
      } finally {
        await runtime.close();
      }
    } finally {
      process.env.PATH = previousPath;
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("does not replay a write whose child exits after dispatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-meridian-write-"));
    const previousPath = process.env.PATH;
    try {
      const truth = await sourceTruth(directory);
      const statePrefix = join(directory, "write");
      await fakeSsh(directory, statePrefix, "canvas_page_update");
      process.env.PATH = `${directory}:${previousPath || ""}`;
      const runtime = await GatewayRuntime.connect(config(truth, ":memory:", true), { journalPath: ":memory:" });
      try {
        const planned = await runtime.call("canvas_page_update", {
          course_id: "101",
          body: "one dispatch",
          _morrow: {
            readback: {
              tool: "canvas_page_get",
              arguments: { course_id: "101" },
              expected_digest: "a".repeat(64),
            },
          },
        });
        const operationId = (planned.structuredContent as { operationId: string }).operationId;
        runtime.approveOperation(operationId);
        const result = await runtime.dispatchOperation(operationId);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          schema: "morrow.result.v1",
          effectState: "applied_or_unknown",
        });
        expect(result._meta).toMatchObject({
          "io.morrow/gateway": { gatewayOperationState: "source_unknown" },
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect((await readFile(`${statePrefix}.calls`, "utf8")).trim().split("\n"))
          .toEqual(["canvas_page_update"]);
        const commands = await readFile(`${statePrefix}.commands`, "utf8");
        expect(commands).toContain(`CHCP_TEAM_JOB_ID='${operationId}'`);
        expect(commands).toMatch(/CHCP_TEAM_TASK_CONTRACT_DIGEST='[0-9a-f]{64}'/);
        expect(commands).toContain("CHCP_TEAM_COURSE_ID='101'");
      } finally {
        await runtime.close();
      }
    } finally {
      process.env.PATH = previousPath;
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
