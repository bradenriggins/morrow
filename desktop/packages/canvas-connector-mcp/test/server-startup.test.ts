import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@modelcontextprotocol/server";
import { createCanvasConnectorMcpServer } from "../src/server.js";
import type { CanvasConnectorRuntime } from "../src/runtime.js";

vi.mock("@modelcontextprotocol/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/server")>();
  return { ...actual, fromJsonSchema: vi.fn(actual.fromJsonSchema) };
});

const binding = { sourceBindingId: "binding-42", provider: "canvas", courseId: "42", origin: "https://canvas.example.edu", runtimeVerified: true,
  principalFingerprint: "b".repeat(64), sessionGeneration: 1, catalogDigest: "c".repeat(64) };

function registeredTools() {
  const tools = new Map<string, Record<string, any>>();
  vi.spyOn(sdk.McpServer.prototype, "registerTool").mockImplementation(((name: string, config: Record<string, any>) => {
    tools.set(name, config);
    return {};
  }) as any);
  const runtime = {
    catalog: { operations: [] }, canvasBrowserCatalog: { operations: [] }, moodleCatalog: { operations: [] },
    acceptsPublicPrivacyScope: () => true, bindings: () => [binding], canvasBindings: () => [binding],
    call: vi.fn(), privacyRoster: async () => [], privateChatExchange: vi.fn(),
  } as unknown as CanvasConnectorRuntime;
  createCanvasConnectorMcpServer(runtime, { internalSourceCapability: "a".repeat(64) });
  return tools;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(sdk.fromJsonSchema).mockClear();
});

describe("Canvas connector startup", () => {
  // Every connection builds the server again, and the packaged catalog has more
  // than a thousand tools. Compiling each input validator up front held the
  // first connection for seconds; a tool's validator is built when it is used.
  it("compiles a tool's input validator only when that tool's input is first checked", async () => {
    const tools = registeredTools();
    expect(tools.size).toBeGreaterThan(0);
    expect(vi.mocked(sdk.fromJsonSchema)).not.toHaveBeenCalled();

    const schema = tools.get("canvas_transfer_course_file")!.inputSchema;
    expect(schema["~standard"].jsonSchema.input({ target: "draft-2020-12" })).toMatchObject({ type: "object" });
    expect(vi.mocked(sdk.fromJsonSchema)).not.toHaveBeenCalled();

    const validate = schema["~standard"].validate;
    expect((await validate({ course_id: 42 })).issues).toBeTruthy();
    expect((await validate({ course_id: "not a course" })).issues).toBeTruthy();
    expect(vi.mocked(sdk.fromJsonSchema)).toHaveBeenCalledTimes(1);
  });
});
