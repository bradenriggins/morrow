import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { INTERNAL_SOURCE_CAPABILITY_META } from "@morrow/gateway-core";
import { createLegacyBridgeMcpServer } from "../src/server.js";
import { LegacyBridgeRuntime } from "../src/runtime.js";

const binding = { sourceBindingId: "binding-42", provider: "canvas", courseId: "42", origin: "https://canvas.example.edu", runtimeVerified: true,
  principalFingerprint: "b".repeat(64), sessionGeneration: 1, catalogDigest: "c".repeat(64) };
afterEach(() => vi.restoreAllMocks());

describe("legacy source MCP privacy", () => {
  it("projects normal reads and cached tasks; authorizes raw output only with request metadata", async () => {
    const callbacks = new Map<string, (...args: any[]) => Promise<any>>();
    vi.spyOn(McpServer.prototype, "registerTool").mockImplementation(((name: string, _config: unknown, callback: (...args: any[]) => Promise<any>) => {
      callbacks.set(name, callback); return {};
    }) as any);
    const result = { ok: true, result: { body: "Mary Jackson wrote mary@example.edu" } };
    const runtime = {
      catalog: { source: { id: "legacy" }, digest: "c".repeat(64), tools: [{ name: "read", inputSchema: { type: "object" } }] },
      acceptsPublicPrivacyScope: () => true, bindings: () => [binding], privacyRoster: async () => [{ id: "912345", name: "Mary Jackson", email: "mary@example.edu" }],
      call: vi.fn(async () => result), taskGet: vi.fn(async () => result),
    } as unknown as LegacyBridgeRuntime;
    createLegacyBridgeMcpServer(runtime, { internalSourceCapability: "a".repeat(64) });
    const read = await callbacks.get("read")!({ course_id: 42, _morrow: { source_binding_id: "binding-42" } }, { mcpReq: {} });
    expect(read.isError).not.toBe(true);
    expect(JSON.stringify(read)).toContain("Student A");
    expect(JSON.stringify(read)).not.toContain("Mary");
    const task = await callbacks.get("morrow_legacy_task_get")!({ task_id: "task-1", source_binding_id: "binding-42" }, { mcpReq: {} });
    expect(JSON.stringify(task)).not.toContain("Mary");
    const raw = await callbacks.get("read")!({}, { mcpReq: { _meta: { [INTERNAL_SOURCE_CAPABILITY_META]: "a".repeat(64) } } });
    expect(raw.structuredContent).toEqual(result);
  });

  it("holds cached tasks until the donor can prove the exact course", () => {
    const runtime = Object.create(LegacyBridgeRuntime.prototype) as LegacyBridgeRuntime;
    expect(runtime.acceptsPublicPrivacyScope("morrow_legacy_task_get", { source_binding_id: "binding-42" }, binding)).toBe(false);
  });

  it("fetches the private complete roster over the bound bridge, without a public tool", async () => {
    const invoke = vi.fn(async () => ({ ok: true, result: { schema: "morrow.legacy-course-roster.v1", complete: true, historyComplete: true, deletedEnrollments: [],
      courseId: "42", sourceBindingId: "binding-42", identities: [{ id: "912345", name: "Mary Jackson" }] } }));
    const runtime = Object.create(LegacyBridgeRuntime.prototype) as LegacyBridgeRuntime;
    Object.defineProperty(runtime, "bridge", { value: { invoke } });
    expect(await runtime.privacyRoster(binding)).toMatchObject([{ id: "912345", name: "Mary Jackson" }]);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ operationKey: "legacy:privacy_roster", sourceBindingId: "binding-42" }));
    invoke.mockResolvedValueOnce({ ok: true, result: { schema: "morrow.legacy-course-roster.v1", complete: true, historyComplete: true, deletedEnrollments: [],
      courseId: "43", sourceBindingId: "binding-42", identities: [] } });
    await expect(runtime.privacyRoster(binding)).rejects.toThrow("privacy_roster_incomplete");
  });
  it("refuses a legacy roster without proved complete enrollment history", async () => {
    const invoke = vi.fn(async () => ({ ok: true, result: { schema: "morrow.legacy-course-roster.v1", complete: true,
      courseId: "42", sourceBindingId: "binding-42", identities: [{ id: "912345", name: "Mary Jackson" }] } }));
    const runtime = Object.create(LegacyBridgeRuntime.prototype) as LegacyBridgeRuntime;
    Object.defineProperty(runtime, "bridge", { value: { invoke } });
    await expect(runtime.privacyRoster(binding)).rejects.toThrow("privacy_roster_history_incomplete");
  });

});
