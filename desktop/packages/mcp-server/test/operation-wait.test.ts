import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { registerOperationTools } from "../src/operation-tools.js";
import type { GatewayRuntime } from "../src/runtime.js";

type WaitInput = { operation_id?: string; batch_id?: string; max_wait_seconds?: number };
type WaitHandler = (input: WaitInput, context: ServerContext) => Promise<CallToolResult>;
type LooseSchema = { safeParse: (value: unknown) => { success: boolean } };

/**
 * Captures the tool `registerOperationTools` registers as `morrow_operation_wait`: its handler and
 * its zod input schema, without standing up a transport. What these tests prove is the poll loop's
 * own timing and its refusal to touch the runtime beyond one durable read, not MCP wire framing --
 * a fake `McpServer` that only records the registration is the smallest thing that can show that.
 */
function registerWait(runtime: GatewayRuntime): { handler: WaitHandler; inputSchema: LooseSchema } {
  let handler: WaitHandler | undefined;
  let inputSchema: LooseSchema | undefined;
  const fakeServer = {
    registerTool: (name: string, definition: { inputSchema: LooseSchema }, callback: WaitHandler) => {
      if (name === "morrow_operation_wait") {
        handler = callback;
        inputSchema = definition.inputSchema;
      }
    },
  } as unknown as McpServer;
  registerOperationTools(fakeServer, runtime);
  if (!handler || !inputSchema) throw new Error("morrow_operation_wait was not registered");
  return { handler, inputSchema };
}

/**
 * A runtime double that answers only `operationGet`, from a scripted list of states (the last one
 * repeats), and throws on any other property a caller reads from it. `morrow_operation_wait` must
 * never reach past its own durable local read to ask a source provider anything while it polls; a
 * property read this double does not expect is exactly that reach, caught at the point it happens.
 */
function operationOnlyRuntime(states: readonly string[], calls: { count: number }): GatewayRuntime {
  const base = {
    operationGet(operationId: string): JsonObject {
      calls.count += 1;
      const state = states[Math.min(calls.count - 1, states.length - 1)]!;
      return { schema: "morrow.operation.v1", operationId, state, attention: [] };
    },
  };
  return new Proxy(base, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      throw new Error(`morrow_operation_wait touched runtime.${String(property)}, not just operationGet`);
    },
  }) as unknown as GatewayRuntime;
}

function context(signal: AbortSignal): ServerContext {
  return {
    mcpReq: {
      signal,
      _meta: undefined,
      notify: async () => undefined,
    },
  } as unknown as ServerContext;
}

describe("morrow_operation_wait", () => {
  it("returns at once for a terminal state", async () => {
    const calls = { count: 0 };
    const { handler } = registerWait(operationOnlyRuntime(["verified"], calls));
    const startedAt = Date.now();
    const result = await handler({ operation_id: "op:terminal-1", max_wait_seconds: 5 }, context(new AbortController().signal));
    expect(Date.now() - startedAt).toBeLessThan(400);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ state: "verified", waited: { timedOut: false } });
    expect(calls.count).toBe(1);
  });

  it("returns once a person answers the review", async () => {
    const calls = { count: 0 };
    const { handler } = registerWait(operationOnlyRuntime(["awaiting_approval", "awaiting_approval", "verified"], calls));
    const result = await handler({ operation_id: "op:answered-1", max_wait_seconds: 5 }, context(new AbortController().signal));
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ state: "verified", waited: { timedOut: false } });
    expect(calls.count).toBe(3);
  });

  it("times out while the review is still open", async () => {
    const calls = { count: 0 };
    const { handler } = registerWait(operationOnlyRuntime(["awaiting_approval"], calls));
    const result = await handler({ operation_id: "op:open-1", max_wait_seconds: 1 }, context(new AbortController().signal));
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as JsonObject;
    expect(structured.waited).toMatchObject({ timedOut: true });
    expect(structured.state).toBe("awaiting_approval");
    expect((structured.attention as string[]).some((entry) => entry.includes("Call morrow_operation_wait again"))).toBe(true);
  });

  it("stops as soon as the request is aborted", async () => {
    const calls = { count: 0 };
    const { handler } = registerWait(operationOnlyRuntime(["awaiting_approval"], calls));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const startedAt = Date.now();
    const result = await handler({ operation_id: "op:aborted-1", max_wait_seconds: 5 }, context(controller.signal));
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as JsonObject;
    expect(structured.waited).toMatchObject({ timedOut: false });
    expect(calls.count).toBe(1);
  });

  it("sends no provider request while it polls", async () => {
    const calls = { count: 0 };
    const { handler } = registerWait(operationOnlyRuntime(["awaiting_approval", "verified"], calls));
    // operationOnlyRuntime throws the moment the handler reaches for any runtime member besides
    // operationGet; finishing this call without that throw is itself the proof, alongside the
    // exact durable-read count below (one read per poll, nothing else in between).
    const result = await handler({ operation_id: "op:local-only-1", max_wait_seconds: 5 }, context(new AbortController().signal));
    expect(result.isError).not.toBe(true);
    expect(calls.count).toBe(2);
  });

  it("requires exactly one of operation_id or batch_id", () => {
    const { inputSchema } = registerWait(operationOnlyRuntime(["verified"], { count: 0 }));
    expect(inputSchema.safeParse({ max_wait_seconds: 5 }).success).toBe(false);
    expect(inputSchema.safeParse({ operation_id: "op:12345678", batch_id: "batch:1", max_wait_seconds: 5 }).success).toBe(false);
    expect(inputSchema.safeParse({ operation_id: "op:12345678" }).success).toBe(true);
    expect(inputSchema.safeParse({ batch_id: "batch:1" }).success).toBe(true);
  });
});
