import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { sha256Text, type JsonObject } from "@morrow/contracts";
import { describe, expect, it, vi } from "vitest";
import { createMorrowServer } from "../src/server.js";
import type { GatewayRuntime } from "../src/runtime.js";

const args = { source_binding_id: "selected-source", course_id: "42", page_url: "cells", quiz_id: "77", source_title: "Cell source", source_text: "Cells have membranes." };
const lesson = { page_id: "91", url: "cells", title: "Cells", body: "<p>Cells lack membranes.</p>" };
function fixture() {
  const calls: { name: string; arguments: JsonObject }[] = [];
  const snapshots: { [name: string]: unknown } = {
    canvas_get_single_course_courses: { id: "42", name: "Biology" }, canvas_show_page_courses: { ...lesson, last_edited_by: { learnerToken: "learner_test" } },
    canvas_get_new_quiz: { id: "77", course_id: "42", title: "Cell quiz", instructions: "Choose an answer." },
    canvas_list_quiz_items: [{ id: "1", entry_type: "Item", entry: { title: "Cell membrane", item_body: "Cells have membranes.", interaction_type_slug: "true-false", interaction_data: { true_choice: "True", false_choice: "False" }, scoring_data: { value: false } } }],
  };
  const runtime = {
    catalog: { tools: [] },
    config: { upstreams: [{ id: "canvas", outputPrivacy: {}, outputPrivacyDefault: { fieldPolicy: "scrub-sensitive", freeText: "allow", aiClientAdmission: "allow" } }] },
    searchCatalog: ({ query }: { query: string }) => ({ tools: [{ publicName: query, upstreamName: query, upstreamId: "canvas", annotations: { readOnlyHint: true } }] }),
    capabilityGet: () => ({ descriptor: { route: { backend: "canvas-connector" } } }),
    callSourceOwned: async (name: string, arguments_: JsonObject) => {
      expect(Object.hasOwn(snapshots, name)).toBe(true);
      calls.push({ name, arguments: arguments_ });
      return { structuredContent: { schema: "morrow.canvas-connector.result.v1", ok: true, commandKind: "invoke_read", result: { ok: true, sent: true, truncated: false, data: snapshots[name], ...(name === "canvas_show_page_courses" ? { pageBodySha256: sha256Text(lesson.body) } : {}) } } };
    },
  } as unknown as GatewayRuntime;
  return { runtime, calls, snapshots };
}

describe("lesson specialist review", () => {
  it("runs two independent requests and one checker through both SDK protocol eras without writes", async () => {
    for (const mode of ["legacy", { pin: "2026-07-28" }] as const) {
      const { runtime, calls } = fixture();
      const client = new Client({ name: "lesson-test", version: "1" }, { capabilities: { sampling: {} }, versionNegotiation: { mode } });
      const requests: string[] = [];
      client.setRequestHandler("sampling/createMessage", async ({ params }) => {
        expect(params.tools).toBeUndefined();
        expect(params.includeContext).toBe("none");
        const data = JSON.parse((params.messages[0]!.content as { text: string }).text);
        const key = data.request_key;
        if (key === "checker") expect(new Set(requests)).toEqual(new Set(["lesson_alignment", "quiz_alignment"]));
        else expect(data).not.toHaveProperty("specialist_results_data");
        requests.push(key);
        const output = key === "checker" ? { request_id: data.request_id, request_key: key, decisions: [{ finding_key: "lesson_alignment:1", verdict: "retain" }, { finding_key: "quiz_alignment:1", verdict: "dispute" }] }
          : { request_id: data.request_id, request_key: key, findings: [{ target_key: key === "lesson_alignment" ? "lesson" : "question:1", source_quote: "Cells have membranes.", target_quote: key === "lesson_alignment" ? "Cells lack membranes." : '"value":false', concern: "The saved statement conflicts with the source.", proposed_correction: key === "lesson_alignment" ? "Cells have membranes." : "Set the saved answer to true." }], limits: [] };
        return { model: `reported-${key}`, role: "assistant", content: { type: "text", text: JSON.stringify(output) }, stopReason: "endTurn" };
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
      await client.connect(a);
      try {
        expect((await client.listTools()).tools.find((tool) => tool.name === "morrow_review_lesson")?.annotations?.readOnlyHint).toBe(true);
        const result = await client.callTool({ name: "morrow_review_lesson", arguments: args });
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
        expect(requests).toHaveLength(3);
        expect(calls).toHaveLength(4);
        expect(calls.every((call) => (call.arguments._morrow as JsonObject).source_binding_id === args.source_binding_id)).toBe(true);
        expect(calls.map((call) => call.name)).toEqual(expect.arrayContaining(["canvas_get_single_course_courses", "canvas_show_page_courses", "canvas_get_new_quiz", "canvas_list_quiz_items"]));
        const report = result.structuredContent as { evidence: unknown; modelRecords: { requestId: string; result: { model: string } }[]; findings: { checkerVerdict: string }[] };
        expect(report.evidence).toMatchObject({ source: { text: args.source_text }, lesson, quiz: { id: args.quiz_id } });
        expect(JSON.stringify(report.evidence)).not.toContain("learner_test");
        expect(new Set(report.modelRecords.map((record) => record.requestId)).size).toBe(3);
        expect(report.modelRecords.map((record) => record.result.model)).toEqual(["reported-lesson_alignment", "reported-quiz_alignment", "reported-checker"]);
        expect(report.findings.map((finding) => finding.checkerVerdict)).toEqual(["retain", "dispute"]);
        expect(JSON.stringify(result.content)).toContain("Educator review is required");
      } finally { await client.close(); await server.close(); }
    }
  });

  it("refuses unsupported clients, changed state, unsupported quotes, and incomplete answers without writes", async () => {
    const { runtime, calls, snapshots } = fixture();
    let client = new Client({ name: "refusal-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    let server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    try {
      expect((await client.callTool({ name: "morrow_review_lesson", arguments: args })).isError).toBe(true);
      expect(calls).toHaveLength(0);
      await client.close(); await server.close();
      client = new Client({ name: "refusal-test", version: "1" }, { capabilities: { sampling: {} }, versionNegotiation: { mode: { pin: "2026-07-28" } } });
      const [a2, b2] = InMemoryTransport.createLinkedPair();
      server = serveStdio(() => createMorrowServer(runtime), { transport: b2 });
      await client.connect(a2);
      const round = await client.callTool({ name: "morrow_review_lesson", arguments: args }, { allowInputRequired: true }) as unknown as { requestState: string; inputRequests: { [key: string]: { params: { messages: { content: { text: string } }[] } } } };
      expect(round.requestState).toMatch(/^v1\./);
      const requestData = JSON.parse(round.inputRequests.lesson_alignment!.params.messages[0]!.content.text);
      const validResponses = Object.fromEntries(["lesson_alignment", "quiz_alignment"].map((key) => [key, { model: "reported-test", role: "assistant", stopReason: "endTurn", content: { type: "text", text: JSON.stringify({ request_id: requestData.request_id, request_key: key, findings: [{ target_key: key === "lesson_alignment" ? "lesson" : "question:1", source_quote: "Cells have membranes.", target_quote: key === "lesson_alignment" ? "Cells lack membranes." : '"value":false', concern: "The saved statement conflicts with the source.", proposed_correction: "Correct the saved content." }], limits: [] }) } }]));
      const responses = Object.fromEntries(["lesson_alignment", "quiz_alignment"].map((key) => [key, { model: "reported-test", role: "assistant", stopReason: "endTurn", content: { type: "text", text: JSON.stringify({ request_id: requestData.request_id, request_key: key, findings: [{ target_key: key === "lesson_alignment" ? "lesson" : "question:1", source_quote: "A fabricated source quote", target_quote: "Cells lack membranes.", concern: "Unsupported", proposed_correction: "Unsupported" }], limits: [] }) } }]));
      const retry = (requestState: string, arguments_ = args) => client.callTool({ name: "morrow_review_lesson", arguments: arguments_, requestState, inputResponses: responses } as Parameters<Client["callTool"]>[0]);
      const expiredRetry = () => client.callTool({ name: "morrow_review_lesson", arguments: args, requestState: round.requestState, inputResponses: validResponses } as Parameters<Client["callTool"]>[0]);
      const dateNow = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 601_000);
      try {
        const expired = await expiredRetry().then((result) => ({ result }), (error: unknown) => ({ error }));
        if ("result" in expired) {
          expect(expired.result.isError).toBe(true);
          expect(JSON.stringify(expired.result.content)).toMatch(/expired|ten minutes/i);
          expect(expired.result).not.toHaveProperty("inputRequests.checker");
        } else {
          expect(expired.error).toBeInstanceOf(Error);
          expect(String(expired.error)).toMatch(/requestState|expired/i);
        }
      } finally {
        dateNow.mockRestore();
      }
      expect(calls).toHaveLength(4);
      await expect(retry(`${round.requestState.slice(0, -4)}AAAA`)).rejects.toThrow("requestState");
      expect((await retry(round.requestState, { ...args, course_id: "43" })).isError).toBe(true);
      const invalid = await retry(round.requestState);
      expect(invalid.isError).toBe(true);
      expect(JSON.stringify(invalid.content)).toContain("not in the captured evidence");
      expect(calls).toHaveLength(4);
      const item = (snapshots.canvas_list_quiz_items as JsonObject[])[0]!;
      snapshots.canvas_list_quiz_items = [{ ...item, entry: { ...(item.entry as JsonObject), scoring_data: null } }];
      const missingAnswer = await client.callTool({ name: "morrow_review_lesson", arguments: args }, { allowInputRequired: true });
      expect(missingAnswer.isError).toBe(true);
      expect(JSON.stringify(missingAnswer.content)).toContain("answer, or rubric content is incomplete");
      expect(calls).toHaveLength(8);
    } finally { await client.close(); await server.close(); }
  });
});
