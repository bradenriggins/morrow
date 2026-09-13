import { request as httpRequest } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { isJsonObject, sha256Json } from "@morrow/contracts";
import { describe, expect, it } from "vitest";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url));
const canvasEntryMarker = fileURLToPath(new URL("../../canvas-connector-mcp/dist/index.js", import.meta.url));
const entryPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const MAX_HTTP_BODY_BYTES = 16 * 1024 * 1024;

interface ConnectedClient {
  readonly client: Client;
  readonly transport: StdioClientTransport;
}

interface OwnerDescriptor {
  readonly pid: number;
  readonly port: number;
  readonly token: string;
}

async function waitUntil(predicate: () => Promise<boolean> | boolean, detail: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${detail}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function readLog(path: string): Promise<readonly string[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function writeConfig(
  directory: string,
  options: { readonly delayMs?: number; readonly privateChat?: boolean } = {},
): Promise<{ configPath: string; journalPath: string; callLogPath: string }> {
  const configPath = join(directory, "morrow.upstreams.json");
  const journalPath = join(directory, "gateway.sqlite3");
  const callLogPath = join(directory, "calls.log");
  await writeFile(configPath, `${JSON.stringify({
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    toolSurface: "full",
    sourcePolicy: { requireAttestation: false },
    upstreams: [{
      id: "morrow-legacy",
      label: "Fixture",
      kind: "mcp-stdio",
      command: process.execPath,
      args: [fixturePath, ...(options.privateChat ? [canvasEntryMarker] : [])],
      env: {
        FAKE_SOURCE: "morrow-legacy",
        FAKE_CALL_LOG: callLogPath,
        ...(options.delayMs ? { FAKE_DELAY_MS: String(options.delayMs) } : {}),
        ...(options.privateChat ? { FAKE_PRIVATE_CHAT: "1" } : {}),
      },
      priority: 1,
      required: true,
      enabled: true,
      outputPrivacy: {
        canvas_page_get: {
          allowedFields: ["source", "course_id"],
          dataClass: "course",
          maxRecords: 10,
          maxBytes: 2_000,
          freeText: "allow",
          learnerTokens: false,
          artifactInspection: "deny",
        },
        ...(options.privateChat ? {
          morrow_browser_bindings: {
            allowedFields: ["schema", "bindings"],
            dataClass: "course",
            maxRecords: 10,
            maxBytes: 2_000,
            freeText: "allow",
            learnerTokens: false,
            artifactInspection: "deny",
          },
        } : {}),
      },
    }],
    filters: { excludePrefixes: [], excludeNames: [] },
    operationJournal: { path: journalPath },
    privacy: {
      canvasOrigin: "local",
      account: "local-account",
      principal: "local-principal",
      learnerVaultPath: join(directory, "learner-vault.json"),
    },
    maxCatalogTools: 20,
  }, null, 2)}\n`, "utf8");
  return { configPath, journalPath, callLogPath };
}

async function connect(configPath: string, name: string, sampling = false): Promise<ConnectedClient> {
  const client = new Client(
    { name, version: "1.0.0" },
    {
      ...(sampling ? { capabilities: { sampling: {} } } : {}),
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entryPath],
    env: { ...getDefaultEnvironment(), MORROW_UPSTREAMS_FILE: configPath },
    stderr: "pipe",
  });
  await client.connect(transport);
  return { client, transport };
}

async function closeClient(connection: ConnectedClient | null): Promise<void> {
  await connection?.client.close().catch(() => undefined);
  await connection?.transport.close().catch(() => undefined);
}

async function stopTestOwner(ownerPath: string): Promise<void> {
  try {
    await waitUntil(() => !existsSync(ownerPath), "the owner's cleanup");
    return;
  } catch {
    const descriptor = JSON.parse(await readFile(ownerPath, "utf8")) as OwnerDescriptor;
    process.kill(descriptor.pid, "SIGTERM");
    await waitUntil(() => !existsSync(ownerPath), "the test owner's bounded stop");
  }
}

async function postOversizedChunkedBody(
  descriptor: OwnerDescriptor,
  proxyPid: number,
  workspaceRoot: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(new Error("timed out waiting for the oversized response"));
    }, 10_000);
    const finish = (result: { status: number; body: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const request = httpRequest({
      host: "127.0.0.1",
      port: descriptor.port,
      method: "POST",
      path: "/mcp",
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        "content-type": "application/json",
        "x-morrow-proxy-pid": String(proxyPid),
        "x-morrow-workspace": Buffer.from(workspaceRoot, "utf8").toString("base64url"),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("end", () => finish({
        status: response.statusCode || 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    void (async () => {
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      for (let sent = 0; sent < MAX_HTTP_BODY_BYTES; sent += chunk.byteLength) {
        if (!request.write(chunk)) await new Promise<void>((resume) => request.once("drain", resume));
      }
      request.end(Buffer.from("x"));
    })().catch((error) => request.destroy(error instanceof Error ? error : new Error(String(error))));
  });
}

async function postOversizedDeclaredBody(
  descriptor: OwnerDescriptor,
  proxyPid: number,
  workspaceRoot: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: descriptor.port,
      method: "POST",
      path: "/mcp",
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        "content-length": String(MAX_HTTP_BODY_BYTES + 1),
        "content-type": "application/json",
        "x-morrow-proxy-pid": String(proxyPid),
        "x-morrow-workspace": Buffer.from(workspaceRoot, "utf8").toString("base64url"),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("end", () => resolve({
        status: response.statusCode || 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.flushHeaders();
  });
}

async function postInvalidUtf8Body(
  descriptor: OwnerDescriptor,
  proxyPid: number,
  workspaceRoot: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: descriptor.port,
      method: "POST",
      path: "/mcp",
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        "content-length": "1",
        "content-type": "application/json",
        "x-morrow-proxy-pid": String(proxyPid),
        "x-morrow-workspace": Buffer.from(workspaceRoot, "utf8").toString("base64url"),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("end", () => resolve({
        status: response.statusCode || 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end(Buffer.from([0xff]));
  });
}

async function createReadBatch(client: Client): Promise<Record<string, unknown>> {
  const profileDigest = sha256Json({ schema: "morrow.modern-cancellation.profile.v1" });
  const created = await client.callTool({
    name: "morrow_batch_create",
    arguments: {
      name: "Modern cancellation stream",
      mode: "read_only",
      concurrency: 1,
      operation_family: "modern-cancellation-stream",
      operations: ["301", "302"].map((courseId) => ({
        child_id: `course:${courseId}`,
        course_id: courseId,
        tool: "canvas_page_get",
        arguments: { course_id: courseId },
      })),
      profile_digest: profileDigest,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    },
  });
  const output = created.structuredContent;
  if (!isJsonObject(output) || !isJsonObject(output.batch) || !isJsonObject(output.manifest)
    || !isJsonObject(output.manifest.courseSet) || typeof output.batch.batchId !== "string"
    || typeof output.manifest.courseSet.digest !== "string") {
    throw new Error("modern cancellation fixture did not create a batch");
  }
  return {
    batch_id: output.batch.batchId,
    max_children: 2,
    course_set_digest: output.manifest.courseSet.digest,
    profile_digest: profileDigest,
  };
}

describe("modern local-owner ingress and lifetime", () => {
  it("aborts only the matching active modern request and keeps the proxy usable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-modern-cancel-"));
    const { configPath, journalPath, callLogPath } = await writeConfig(directory, { delayMs: 1_200 });
    const ownerPath = `${journalPath}.local-owner.json`;
    let connection: ConnectedClient | null = null;
    try {
      connection = await connect(configPath, "modern-cancellation");
      const cancellation = new AbortController();
      const cancelledCall = connection.client.callTool(
        { name: "canvas_page_get", arguments: { course_id: "101" } },
        { signal: cancellation.signal },
      );
      const survivingCall = connection.client.callTool(
        { name: "canvas_page_get", arguments: { course_id: "202" } },
      );
      await waitUntil(async () => (await readLog(callLogPath)).filter((entry) => entry === "canvas_page_get").length === 2, "both upstream calls");
      cancellation.abort(new Error("test cancellation"));
      await expect(cancelledCall).rejects.toThrow();
      await waitUntil(async () => (await readLog(callLogPath)).includes("aborted"), "the upstream abort");
      await expect(survivingCall).resolves.toMatchObject({ structuredContent: { data: { course_id: "202" } } });
      await expect(connection.client.callTool({ name: "morrow_health", arguments: {} })).resolves.toMatchObject({
        structuredContent: { schema: "morrow.health.v1", ready: true },
      });
    } finally {
      await closeClient(connection);
      await stopTestOwner(ownerPath);
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("keeps cancellation ownership after a modern response becomes an SSE progress stream", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-modern-stream-cancel-"));
    const { configPath, journalPath, callLogPath } = await writeConfig(directory, { delayMs: 250 });
    const ownerPath = `${journalPath}.local-owner.json`;
    let connection: ConnectedClient | null = null;
    try {
      connection = await connect(configPath, "modern-stream-cancellation");
      const runInput = await createReadBatch(connection.client);
      const cancellation = new AbortController();
      let progressCount = 0;
      const running = connection.client.callTool(
        { name: "morrow_batch_run", arguments: runInput },
        {
          signal: cancellation.signal,
          onprogress: () => {
            progressCount += 1;
            if (progressCount === 1) cancellation.abort(new Error("cancel after first progress"));
          },
        },
      );
      await expect(running).rejects.toThrow();
      await waitUntil(async () => (await readLog(callLogPath)).includes("aborted"), "the streamed request abort");
      expect(progressCount).toBe(1);
      await expect(connection.client.callTool({ name: "morrow_health", arguments: {} })).resolves.toMatchObject({
        structuredContent: { schema: "morrow.health.v1", ready: true },
      });
    } finally {
      await closeClient(connection);
      await stopTestOwner(ownerPath);
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("shares signed Private Chat continuation state for one proxy and isolates another proxy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-modern-continuation-"));
    const { configPath, journalPath, callLogPath } = await writeConfig(directory, { privateChat: true });
    const ownerPath = `${journalPath}.local-owner.json`;
    let first: ConnectedClient | null = null;
    let second: ConnectedClient | null = null;
    try {
      first = await connect(configPath, "modern-private-chat", true);
      const round = await first.client.callTool(
        { name: "morrow_private_chat", arguments: {} },
        { allowInputRequired: true },
      ) as unknown as { requestState: string };
      expect(round).toMatchObject({ resultType: "input_required", requestState: expect.any(String) });

      second = await connect(configPath, "modern-private-chat-peer", true);
      const reply = (client: Client) => client.callTool({
        name: "morrow_private_chat",
        arguments: {},
        requestState: round.requestState,
        inputResponses: {
          private_chat_reply: {
            model: "local-test",
            role: "assistant",
            content: { type: "text", text: "Student A1 needs feedback." },
          },
        },
      } as Parameters<Client["callTool"]>[0], { allowInputRequired: true });
      await expect(reply(second.client)).rejects.toThrow("requestState");
      await expect(reply(first.client)).resolves.toMatchObject({
        structuredContent: { schema: "morrow.private-chat.v1", status: "closed", turns: 1 },
      });
      await expect(reply(first.client)).resolves.toMatchObject({
        isError: true,
        structuredContent: { schema: "morrow.problem.v1", code: "private_chat_unavailable" },
      });
      expect(await readLog(callLogPath)).toEqual([
        "morrow_private_chat_exchange:listen",
        "morrow_private_chat_exchange:reply_and_listen",
      ]);
    } finally {
      await Promise.all([closeClient(second), closeClient(first)]);
      await stopTestOwner(ownerPath);
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("rejects a chunked body at the exact 16 MiB boundary before protocol classification", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-modern-body-limit-"));
    const { configPath, journalPath } = await writeConfig(directory);
    const ownerPath = `${journalPath}.local-owner.json`;
    const workspaceRoot = await realpath(process.cwd());
    let connection: ConnectedClient | null = null;
    try {
      connection = await connect(configPath, "modern-body-limit");
      expect(connection.transport.pid).not.toBeNull();
      const descriptor = JSON.parse(await readFile(ownerPath, "utf8")) as OwnerDescriptor;
      await expect(postOversizedDeclaredBody(descriptor, connection.transport.pid!, workspaceRoot)).resolves.toEqual({
        status: 413,
        body: JSON.stringify({ schema: "morrow.problem.v1", code: "local_owner_message_too_large" }),
      });
      const result = await postOversizedChunkedBody(descriptor, connection.transport.pid!, workspaceRoot);
      expect(result).toEqual({
        status: 413,
        body: JSON.stringify({ schema: "morrow.problem.v1", code: "local_owner_message_too_large" }),
      });
      await expect(connection.client.callTool({ name: "morrow_health", arguments: {} })).resolves.toMatchObject({
        structuredContent: { schema: "morrow.health.v1", ready: true },
      });
    } finally {
      await closeClient(connection);
      await stopTestOwner(ownerPath);
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("rejects malformed UTF-8 before JSON protocol classification", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-modern-utf8-"));
    const { configPath, journalPath } = await writeConfig(directory);
    const ownerPath = `${journalPath}.local-owner.json`;
    const workspaceRoot = await realpath(process.cwd());
    let connection: ConnectedClient | null = null;
    try {
      connection = await connect(configPath, "modern-utf8");
      expect(connection.transport.pid).not.toBeNull();
      const descriptor = JSON.parse(await readFile(ownerPath, "utf8")) as OwnerDescriptor;
      await expect(postInvalidUtf8Body(descriptor, connection.transport.pid!, workspaceRoot)).resolves.toEqual({
        status: 400,
        body: JSON.stringify({ schema: "morrow.problem.v1", code: "local_owner_message_invalid_utf8" }),
      });
      await expect(connection.client.callTool({ name: "morrow_health", arguments: {} })).resolves.toMatchObject({
        structuredContent: { schema: "morrow.health.v1", ready: true },
      });
    } finally {
      await closeClient(connection);
      await stopTestOwner(ownerPath);
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
