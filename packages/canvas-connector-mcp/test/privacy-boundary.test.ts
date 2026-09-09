import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { INTERNAL_SOURCE_CAPABILITY_META, SourceMcpPrivacyBoundary, sourcePrivacyInputSchema } from "@morrow/gateway-core";
import { createCanvasConnectorMcpServer } from "../src/server.js";
import { loadMoodleBrowserCatalog } from "../src/browser-catalog.js";
import { CanvasConnectorRuntime } from "../src/runtime.js";

const binding = { sourceBindingId: "binding-42", provider: "canvas", courseId: "42", origin: "https://canvas.example.edu", runtimeVerified: true,
  principalFingerprint: "b".repeat(64), sessionGeneration: 1, catalogDigest: "c".repeat(64) };
const raw = { ok: true, result: { body: "Mary Jackson sent a message. mary@example.edu" } };
function harness(capability?: string) {
  const callbacks = new Map<string, { config: Record<string, any>; callback: (...args: any[]) => Promise<any> }>();
  vi.spyOn(McpServer.prototype, "registerTool").mockImplementation(((name: string, config: Record<string, any>, callback: (...args: any[]) => Promise<any>) => {
    callbacks.set(name, { config, callback });
    return {};
  }) as any);
  const call = vi.fn(async () => raw);
  const privateChatExchange = vi.fn(async () => ({ schema: "morrow.private-chat.exchange.v1", status: "closed" }));
  const runtime = {
    catalog: { operations: [] }, canvasBrowserCatalog: { operations: [] }, moodleCatalog: { operations: [] },
    acceptsPublicPrivacyScope: () => true, bindings: () => [binding], canvasBindings: () => [binding], call,
    privacyRoster: async () => [{ id: "912345", name: "Mary Jackson", email: "mary@example.edu" }], privateChatExchange,
  } as unknown as CanvasConnectorRuntime;
  createCanvasConnectorMcpServer(runtime, { internalSourceCapability: capability });
  return { callbacks, call, privateChatExchange };
}
afterEach(() => vi.restoreAllMocks());

describe("Canvas source MCP handler privacy", () => {
  it("validates readable learner labels in scalar and recipient-array inputs", async () => {
    const schema = fromJsonSchema(sourcePrivacyInputSchema({ type: "object", properties: {
      course_id: { type: "integer" }, user_id: { type: "integer" }, recipients: { type: "array", items: { type: "integer" } },
    }, required: ["course_id", "user_id", "recipients"], additionalProperties: false }));
    const validate = schema["~standard"].validate;
    expect((await validate({ course_id: 42, user_id: "Student A1", recipients: ["Student A1"] })).issues).toBeUndefined();
    expect((await validate({ course_id: "Student A1", user_id: "Student A1", recipients: [] })).issues).toBeTruthy();
  });

  it("wraps internal source tools and does not advertise the private capability", async () => {
    const { callbacks, call, privateChatExchange } = harness("a".repeat(64));
    const tool = callbacks.get("canvas_send_private_conversation")!;
    const args = { course_id: 42, privateConversation: { body: "Mary Jackson" }, _morrow: { source_binding_id: "binding-42" } };
    expect((await tool.callback(args, { mcpReq: {} })).isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
    expect(JSON.stringify([...callbacks.values()].map((entry) => entry.config))).not.toContain(INTERNAL_SOURCE_CAPABILITY_META);
    const result = await tool.callback(args, { mcpReq: { _meta: { [INTERNAL_SOURCE_CAPABILITY_META]: "a".repeat(64) } } });
    expect(result.structuredContent).toEqual(raw);
    expect(call).toHaveBeenCalledTimes(1);

    const privateChat = callbacks.get("morrow_private_chat_exchange")!;
    const chatArgs = { schema: "morrow.private-chat.exchange.v1", action: "listen", sessionId: "session:one", assistantName: "Codex" };
    expect((await privateChat.callback(chatArgs, { mcpReq: {} })).isError).toBe(true);
    expect(privateChatExchange).not.toHaveBeenCalled();
    expect((await privateChat.callback(chatArgs, { mcpReq: { _meta: { [INTERNAL_SOURCE_CAPABILITY_META]: "a".repeat(64) }, signal: new AbortController().signal } })).structuredContent)
      .toMatchObject({ status: "closed" });
    expect(privateChatExchange).toHaveBeenCalledTimes(1);
  });

  it("has no raw route on a standalone server even when the caller supplies capability metadata", async () => {
    const { callbacks, call } = harness();
    const tool = callbacks.get("canvas_send_private_conversation")!;
    const result = await tool.callback({}, { mcpReq: { _meta: { [INTERNAL_SOURCE_CAPABILITY_META]: "a".repeat(64) } } });
    expect(result.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("Canvas roster authority", () => {
  it("rejects an unscoped operation even if the caller supplies a course binding", () => {
    const runtime = Object.create(CanvasConnectorRuntime.prototype) as CanvasConnectorRuntime;
    Object.defineProperty(runtime, "operations", { value: new Map([["moodle_list_my_courses", { provider: "moodle", toolName: "moodle_list_my_courses" }]]) });
    expect(runtime.acceptsPublicPrivacyScope("moodle_list_my_courses", { course_id: "42" }, { ...binding, provider: "moodle" })).toBe(false);
    expect(runtime.acceptsPublicPrivacyScope("unknown", { course_id: "42" }, binding)).toBe(false);
  });

  it("requires Moodle roster completeness and every binding proof field", async () => {
    const runtime = Object.create(CanvasConnectorRuntime.prototype) as CanvasConnectorRuntime;
    const moodleBinding = { ...binding, provider: "moodle", siteUrl: binding.origin };
    const roster = { ...moodleBinding, schema: "morrow.moodle-course-roster.v1", complete: true, status: "complete", identities: [{ id: "912345", name: "Mary Jackson" }] };
    runtime.call = vi.fn(async () => ({ ok: true, commandKind: "invoke_read", result: { ok: true, sent: true, truncated: false, data: roster } }));
    expect(await runtime.privacyRoster(moodleBinding)).toMatchObject([{ id: "912345" }]);
    roster.sessionGeneration = 2;
    await expect(runtime.privacyRoster(moodleBinding)).rejects.toThrow("privacy_roster_mismatch");
  });

  it("accepts only a complete read and retains every identity alias", async () => {
    const runtime = Object.create(CanvasConnectorRuntime.prototype) as CanvasConnectorRuntime;
    const call = vi.fn(async (toolName: string) => ({ ok: true, commandKind: "invoke_read", result: { ok: true, sent: true, truncated: false,
      data: toolName === "canvas_list_enrollments_courses" ? [] : [{ id: 912345, name: "Mary Jackson", short_name: "MJ", sortable_name: "Jackson, Mary", login_id: "mjackson", email: "mary@example.edu" }] } }));
    runtime.call = call;
    expect(await runtime.privacyRoster(binding)).toMatchObject([{ id: "912345", aliases: ["Jackson, Mary", "MJ"], loginId: "mjackson" }]);
    expect(call).toHaveBeenCalledWith("canvas_list_users_in_course_users", expect.objectContaining({ course_id: "42", morrow_max_pages: 50 }));
    call.mockResolvedValueOnce({ ok: true, commandKind: "invoke_read", result: { ok: true, sent: true, truncated: true, data: [] } });
    await expect(runtime.privacyRoster(binding)).rejects.toThrow("privacy_roster_incomplete");
  });
});


describe("historical course identity boundary", () => {
  const current = { id: "912345", name: "Mary Jackson" };
  const former = { id: "818181", name: "Alice Former", email: "alice@example.edu", login_id: "aformer" };
  const deleted = { course_id: "42", type: "StudentEnrollment", enrollment_state: "deleted", user_id: former.id, user: former };
  const result = (data: unknown, truncated: boolean | undefined = false) => ({ ok: true, commandKind: "invoke_read", result: { ok: true, sent: true, ...(truncated === undefined ? {} : { truncated }), data } });

  it("loads deleted enrollment history with bounded pagination and merges its users", async () => {
    const runtime = Object.create(CanvasConnectorRuntime.prototype) as CanvasConnectorRuntime;
    runtime.call = vi.fn(async (name) => result(name === "canvas_list_enrollments_courses" ? [deleted, { ...deleted, id: "second-section" }] : [current]));
    expect(await runtime.privacyRoster(binding)).toMatchObject([current, { id: former.id, name: former.name, email: former.email, loginId: "aformer" }]);
    expect(runtime.call).toHaveBeenLastCalledWith("canvas_list_enrollments_courses", {
      course_id: "42", type: ["StudentEnrollment"], state: ["deleted"], include: ["uuid"], morrow_max_pages: 50,
      _morrow: { source_binding_id: "binding-42" },
    });
  });

  it.each([true, undefined])("refuses historical pages when complete pagination is not proved (%s)", async (truncated) => {
    const runtime = Object.create(CanvasConnectorRuntime.prototype) as CanvasConnectorRuntime;
    runtime.call = vi.fn(async (name) => name === "canvas_list_enrollments_courses"
      ? { ok: true, commandKind: "invoke_read", result: { ok: true, sent: true, ...(truncated === undefined ? {} : { truncated }), data: [deleted] } }
      : result([current]));
    await expect(runtime.privacyRoster(binding)).rejects.toThrow("privacy_roster_history_incomplete");
  });

  it("refuses unavailable or mismatched history instead of trusting current users alone", async () => {
    const runtime = Object.create(CanvasConnectorRuntime.prototype) as CanvasConnectorRuntime;
    runtime.call = vi.fn(async (name) => name === "canvas_list_enrollments_courses" ? { ok: false } : result([current]));
    await expect(runtime.privacyRoster(binding)).rejects.toThrow("privacy_roster_history_incomplete");
    runtime.call = vi.fn(async (name) => result(name === "canvas_list_enrollments_courses" ? [{ ...deleted, course_id: "43" }] : [current]));
    await expect(runtime.privacyRoster(binding)).rejects.toThrow("privacy_roster_history_mismatch");
  });

  it("holds former-user forum, submission, and history reads while allowing course-authored pages", () => {
    const runtime = Object.create(CanvasConnectorRuntime.prototype) as CanvasConnectorRuntime;
    const catalog = loadMoodleBrowserCatalog();
    Object.defineProperty(runtime, "operations", { value: new Map(catalog.operations.map((operation) => [operation.toolName, operation])) });
    const moodleBinding = { ...binding, provider: "moodle" };
    for (const name of ["moodle_get_forum_posts", "moodle_get_assignment_submission", "moodle_get_assignment_submission_summary",
      "moodle_get_course_log_summary", "moodle_get_quiz_attempt", "moodle_list_wiki_pages", "moodle_get_glossary_entry"]) {
      expect(runtime.acceptsPublicPrivacyScope(name, { course_id: "42" }, moodleBinding), name).toBe(false);
    }
    for (const name of ["moodle_get_page", "moodle_get_forum", "moodle_get_course_participant_roster"]) {
      expect(runtime.acceptsPublicPrivacyScope(name, { course_id: "42" }, moodleBinding), name).toBe(true);
    }
  });
  it("refuses historical Moodle data before dispatch and reads a course-authored page through the same boundary", async () => {
    const runtime = Object.create(CanvasConnectorRuntime.prototype) as CanvasConnectorRuntime;
    const catalog = loadMoodleBrowserCatalog();
    Object.defineProperty(runtime, "operations", { value: new Map(catalog.operations.map((operation) => [operation.toolName, operation])) });
    const moodleBinding = { ...binding, provider: "moodle", siteUrl: binding.origin };
    const boundary = new SourceMcpPrivacyBoundary({ source: "test", bindings: () => [moodleBinding],
      acceptsCourseRequest: (name, args, scope) => runtime.acceptsPublicPrivacyScope(name, args, scope),
      loadRoster: async () => [current],
    });
    const request = { course_id: "42", _morrow: { source_binding_id: binding.sourceBindingId } };
    const formerContent = vi.fn(async () => ({ content: [{ type: "text", text: "Alice Former posted this" }] }));
    for (const name of ["moodle_get_forum_posts", "moodle_get_assignment_submission", "moodle_get_course_log_summary"]) {
      expect((await boundary.invoke(name, request, undefined, formerContent)).isError).toBe(true);
    }
    expect(formerContent).not.toHaveBeenCalled();
    const page = vi.fn(async () => ({ content: [{ type: "text", text: "Read the course introduction before the first lesson." }] }));
    expect((await boundary.invoke("moodle_get_page", request, undefined, page)).isError).not.toBe(true);
    expect(page).toHaveBeenCalledTimes(1);
  });

});
