import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { sha256Text, type JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { newQuizSettingsWriteSchema } from "../../canvas-connector-mcp/src/server.js";
import { matchesBridgeEditPermission } from "../../bridge-protocol/src/index.js";
import { newQuizSettingsDigestSource } from "../../../connector/extension/src/new-quiz-write-contract.js";
import { canvasOperationAdmission } from "../../../connector/extension/generated/canvas-operation-admission.js";
import { newQuizSettingsDigest, planNewQuizSettings, registerNewQuizSettingsTool } from "../src/new-quiz-settings.js";
import type { GatewayRuntime } from "../src/runtime.js";

const sourceBindingId = "canvas:instructor";
const input = { source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77" };
const current = {
  id: "77", course_id: "42", title: "Cell Structure Check",
  quiz_settings: {
    shuffle_answers: false, require_student_access_code: true, student_access_code: "cells",
    has_time_limit: true, session_time_limit_in_seconds: 600, filter_ip_address: true,
    result_view_settings: { display_items: true, display_item_response: true,
      display_item_response_correctness: true, display_item_correct_answer: false },
    multiple_attempts: { multiple_attempts_enabled: true, attempt_limit: true, max_attempts: 3 },
    filters: { ips: [["192.0.2.1", "192.0.2.2"]] },
    provider_extension: { "2": "two", "10": "ten" },
  },
};
const catalog = JSON.parse(readFileSync(new URL("../../../artifacts/canvas-api/canvas-api-catalog.json", import.meta.url), "utf8"));
const operation = catalog.operations.find((entry: { toolName: string }) => entry.toolName === "canvas_update_single_quiz");
const contentSource = readFileSync(new URL("../../../connector/extension/src/canvas-content.js", import.meta.url), "utf8");

function fixture(quiz: JsonObject = current) {
  const calls: { tool: string; args: JsonObject }[] = [];
  const plans: { tool: string; args: JsonObject }[] = [];
  const runtime = {
    catalog: { tools: [{ publicName: operation.toolName, inputSchema: newQuizSettingsWriteSchema(operation.inputSchema) }] },
    searchCatalog: ({ query }: { query: string }) => ({ tools: [{ publicName: query, upstreamName: query, upstreamId: "canvas-session", annotations: { readOnlyHint: query !== operation.toolName } }] }),
    capabilityGet: () => ({ descriptor: { route: { backend: "canvas-connector" } } }),
    callSourceOwned: async (tool: string, args: JsonObject) => {
      calls.push({ tool, args });
      expect(args._morrow).toEqual({ source_binding_id: sourceBindingId });
      const data = tool === "canvas_get_single_course_courses" ? { id: "42", name: "Biology" }
        : tool === "canvas_get_new_quiz" ? quiz : null;
      if (!data) throw new Error(`Unexpected write or read: ${tool}`);
      return { structuredContent: { schema: "morrow.canvas-connector.result.v1", ok: true, commandKind: "invoke_read",
        result: { ok: true, sent: true, truncated: false, data } } };
    },
    resultPage: () => { throw new Error("Unexpected artifact"); },
    planOperationWithCurrentEditPermission: async (tool: string, args: JsonObject) => {
      plans.push({ tool, args });
      return { content: [], structuredContent: { schema: "morrow.operation.v1", operationId: "operation:settings", effectState: "awaiting_approval" } };
    },
  } as unknown as GatewayRuntime;
  return { runtime, calls, plans };
}

async function execute(args: JsonObject, quiz: JsonObject = current) {
  let listener: (message: unknown, sender: unknown, response: (value: JsonObject) => void) => boolean;
  let saved = structuredClone(quiz);
  const writes: JsonObject[] = [];
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  const origin = "https://school.instructure.com";
  runInNewContext(contentSource, {
    location: { origin, protocol: "https:", pathname: "/courses/42/quizzes" },
    document: { cookie: "_csrf_token=csrf-value" },
    Headers, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout, crypto: webcrypto,
    chrome: { runtime: { onMessage: { addListener: (value: typeof listener) => { listener = value; } } } },
    fetch: async (input: URL | string, options: RequestInit = {}) => {
      const url = new URL(String(input), origin);
      if (url.pathname === "/api/v1/users/self/profile") return json({ id: "7" });
      if (url.pathname === "/api/v1/courses/42") return json({ id: "42", name: "Biology" });
      expect(url.pathname).toBe("/api/quiz/v1/courses/42/quizzes/77");
      if (options.method === "PATCH") {
        const body = JSON.parse(String(options.body));
        writes.push(body);
        saved = { ...saved, ...body.quiz };
        return json(saved);
      }
      return json(saved);
    },
  });
  const { _morrow, ...providerArguments } = args;
  const result = await new Promise<JsonObject>((resolve) => listener({
    type: "morrow_canvas_execute", operation: { ...operation, morrowCourseTarget: canvasOperationAdmission(operation).courseTarget },
    arguments: providerArguments, principalId: "7", expiresAt: Date.now() + 60_000, courseId: "42",
  }, null, resolve));
  return { result, writes, saved };
}

describe("New Quiz settings planner", () => {
  it("registers a planner that creates the existing review operation and sends a complete preserved block only after dispatch", async () => {
    const { runtime, calls, plans } = fixture();
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => {
      const mcp = new McpServer({ name: "settings-test", version: "1" });
      registerNewQuizSettingsTool(mcp, runtime);
      return mcp;
    }, { transport: b });
    const client = new Client({ name: "settings-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(a);
    try {
      const listed = (await client.listTools()).tools.find((entry) => entry.name === "morrow_plan_new_quiz_settings");
      expect(listed?.annotations?.readOnlyHint).toBe(true);
      const result = await client.callTool({ name: "morrow_plan_new_quiz_settings", arguments: { ...input,
        settings: { shuffle_answers: true, require_student_access_code: false, student_access_code: null,
          filter_ip_address: false, filters: { ips: null }, result_view_settings: { display_item_correct_answer: true } } } });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ operationId: "operation:settings", effectState: "awaiting_approval",
        settings_plan: { course: { id: "42" }, quiz: { id: "77" }, preserved_settings: expect.arrayContaining(["multiple_attempts.max_attempts", "result_view_settings.display_items"]) } });
      expect(calls.map((call) => call.tool).sort()).toEqual(["canvas_get_new_quiz", "canvas_get_single_course_courses"]);
      expect(plans).toHaveLength(1);
      expect(plans[0]!.args).toMatchObject({ course_id: "42", assignment_id: "77", _morrow: { source_binding_id: sourceBindingId },
        morrow_new_quiz_settings_guard: { current_quiz_settings_sha256: sha256Text(newQuizSettingsDigestSource(current.quiz_settings)) } });
      const dispatched = await execute(plans[0]!.args);
      expect(dispatched.result).toMatchObject({ ok: true, verification: { status: "verified" } });
      expect(dispatched.writes).toEqual([{ quiz: { quiz_settings: { ...current.quiz_settings, shuffle_answers: true,
        require_student_access_code: false, student_access_code: null, filter_ip_address: false, filters: { ips: null },
        result_view_settings: { display_items: true, display_item_response: true,
          display_item_response_correctness: true, display_item_correct_answer: true } } } }]);
    } finally { await client.close(); await server.close(); }
  });

  it("refuses the planner's guard when saved settings change before dispatch", async () => {
    const { runtime, plans } = fixture();
    const planned = await planNewQuizSettings(runtime, { ...input, settings: { shuffle_answers: true } });
    expect(planned.isError).not.toBe(true);
    const changed = { ...current, quiz_settings: { ...current.quiz_settings, session_time_limit_in_seconds: 1200 } };
    const dispatched = await execute(plans[0]!.args, changed);
    expect(dispatched.result).toMatchObject({ ok: false, sent: false, error: expect.stringMatching(/^new_quiz_settings_stale:/) });
    expect(dispatched.writes).toEqual([]);
  });

  it("rejects a mismatched quiz or course and an unsupported setting before review", async () => {
    for (const quiz of [{ ...current, id: "78" }, { ...current, course_id: "43" }, { ...current, quiz_settings: null }]) {
      const { runtime, plans } = fixture(quiz);
      expect((await planNewQuizSettings(runtime, { ...input, settings: { shuffle_answers: true } })).isError).toBe(true);
      expect(plans).toEqual([]);
    }
    for (const settings of [{ unknown_setting: true }, { result_view_settings_display_items: false }, { shuffle_answers: "yes" }]) {
      const { runtime, plans } = fixture();
      expect((await planNewQuizSettings(runtime, { ...input, settings })).isError).toBe(true);
      expect(plans).toEqual([]);
    }
  });

  it("rejects invalid enums, ranges, dates, and dependent settings before review", async () => {
    const cases: readonly [JsonObject, string][] = [
      [{ calculator_type: "graphing" }, "calculator_type"],
      [{ one_at_a_time_type: "page" }, "one_at_a_time_type"],
      [{ session_time_limit_in_seconds: 0 }, "positive whole number"],
      [{ filters: { ips: [] } }, "filters.ips"],
      [{ filters: { ips: [["x", "y"]] } }, "filters.ips"],
      [{ multiple_attempts: { score_to_keep: "best" } }, "score_to_keep"],
      [{ result_view_settings: { display_item_response_qualifier: "sometimes" } }, "unsupported value"],
      [{ result_view_settings: { show_item_responses_at: "tomorrow" } }, "Canvas date and time"],
      [{ result_view_settings: { show_item_responses_at: "2026-09-08" } }, "Canvas date and time"],
      [{ allow_backtracking: true, one_at_a_time_type: "none" }, "one_at_a_time_type is question"],
      [{ filter_ip_address: true, filters: { ips: null } }, "IP filtering needs"],
      [{ has_time_limit: true, session_time_limit_in_seconds: null }, "A time limit needs"],
      [{ require_student_access_code: true, student_access_code: null }, "An access code needs"],
      [{ has_time_limit: false }, "Set session_time_limit_in_seconds to null"],
      [{ require_student_access_code: false }, "Set student_access_code to null"],
      [{ filter_ip_address: false }, "Set filters.ips to null"],
      [{ multiple_attempts: { multiple_attempts_enabled: false } }, "Clear active attempt limit and cooling settings"],
      [{ multiple_attempts: { attempt_limit: false } }, "Set multiple_attempts.max_attempts to null"],
      [{ multiple_attempts: { multiple_attempts_enabled: false, attempt_limit: true, max_attempts: 2 } }, "multiple_attempts_enabled true"],
      [{ multiple_attempts: { cooling_period: true, cooling_period_seconds: null } }, "A cooling period needs"],
      [{ result_view_settings: { display_items: false } }, "Disable item feedback, response, and correctness settings"],
      [{ result_view_settings: { display_item_response: false } }, "Clear response times and disable correctness"],
      [{ result_view_settings: { display_items: false, display_item_feedback: true } }, "display_items true"],
      [{ result_view_settings: { display_item_response: false, display_item_response_correctness: true } }, "display_item_response true"],
      [{ result_view_settings: { display_item_response_correctness: false, display_item_correct_answer: true } }, "display_item_response_correctness true"],
      [{ result_view_settings: { result_view_restricted: false, display_points_awarded: true } }, "result_view_restricted true"],
      [{ result_view_settings: { show_item_responses_at: "2026-09-08T12:00:00Z", hide_item_responses_at: "2026-09-08T12:00:00Z" } }, "hide time must be later"],
      [{ result_view_settings: { show_item_response_correctness_at: "2026-09-09T12:00:00Z", hide_item_response_correctness_at: "2026-09-08T12:00:00Z" } }, "hide time must be later"],
    ];
    for (const [settings, reason] of cases) {
      const { runtime, plans } = fixture();
      const result = await planNewQuizSettings(runtime, { ...input, settings });
      expect(result.isError, JSON.stringify({ settings, result })).toBe(true);
      expect(JSON.stringify(result), JSON.stringify(settings)).toContain(reason);
      expect(plans).toEqual([]);
    }
    const activeCorrectAnswer = structuredClone(current);
    activeCorrectAnswer.quiz_settings.result_view_settings.display_item_correct_answer = true;
    const { runtime, plans } = fixture(activeCorrectAnswer);
    const result = await planNewQuizSettings(runtime, { ...input,
      settings: { result_view_settings: { display_item_response_correctness: false } } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("disable correct-answer display");
    expect(plans).toEqual([]);
  });

  it("accepts atomic parent disable clears, null result dates, and ordered visibility windows", async () => {
    const cases: JsonObject[] = [
      { has_time_limit: false, session_time_limit_in_seconds: null },
      { require_student_access_code: false, student_access_code: null },
      { filter_ip_address: false, filters: { ips: null } },
      { multiple_attempts: { multiple_attempts_enabled: false, attempt_limit: false, max_attempts: null } },
      { result_view_settings: { display_item_response_correctness: false, display_item_correct_answer: false,
        show_item_response_correctness_at: null, hide_item_response_correctness_at: null } },
      { result_view_settings: { show_item_responses_at: "2026-09-08T12:00:00Z", hide_item_responses_at: "2026-09-09T12:00:00Z" } },
    ];
    for (const settings of cases) {
      const { runtime, plans } = fixture();
      const result = await planNewQuizSettings(runtime, { ...input, settings });
      expect(result.isError, JSON.stringify({ settings, result })).not.toBe(true);
      expect(plans).toHaveLength(1);
    }
  });

  it("does not create an operation for unchanged settings and uses the extension digest encoding", async () => {
    const { runtime, plans } = fixture();
    const result = await planNewQuizSettings(runtime, { ...input, settings: { shuffle_answers: false } });
    expect(result.structuredContent).toMatchObject({ status: "unchanged", operation_count: 0 });
    expect(plans).toEqual([]);
    expect(newQuizSettingsDigest(current.quiz_settings)).toBe(sha256Text(newQuizSettingsDigestSource(current.quiz_settings)));
  });

  it("requires review even if a standing Edit rule names every requested field", () => {
    const binding = {
      sourceBindingId, provider: "canvas" as const, runtimeVerified: true,
      editPermission: {
        schema: "morrow.bridge.edit-permission.v1" as const, revision: 1, scopeDigest: "a".repeat(64),
        catalogDigest: catalog.catalogDigest, sourceBindingId, enabledCategories: ["quiz-settings"],
        rules: [{ operationKey: operation.key, toolName: operation.toolName,
          allowedChangedFields: ["quiz_quiz_settings_shuffle_answers", "morrow_new_quiz_settings_guard"] }],
      },
    };
    const request = { provider: "canvas" as const, catalogDigest: catalog.catalogDigest, operationKey: operation.key,
      toolName: operation.toolName, arguments: { course_id: "42", assignment_id: "77", quiz_quiz_settings_shuffle_answers: true } };
    expect(matchesBridgeEditPermission(binding, request)).toBe(true);
    expect(matchesBridgeEditPermission(binding, { ...request, arguments: { ...request.arguments,
      morrow_new_quiz_settings_guard: { current_quiz_settings_sha256: newQuizSettingsDigest(current.quiz_settings) } } })).toBe(false);
  });
});
