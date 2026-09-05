import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256Json, type JsonObject } from "@morrow/contracts";
import { parseGatewayConfig } from "../src/config.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";
import { GatewayRuntime } from "../src/runtime.js";
import { LoopbackApprovalServer } from "../src/approval-server.js";
import type { ApprovalReviewContext } from "../src/approval-context.js";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url));

function config() {
  return parseGatewayConfig({
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    upstreams: [
      {
        id: "example-legacy",
        label: "Morrow legacy fixture",
        kind: "mcp-stdio",
        command: process.execPath,
        args: [fixturePath],
        env: { FAKE_SOURCE: "example-legacy" },
        priority: 50,
        required: true,
        enabled: true,
        outputPrivacy: {
          canvas_page_get: {
            allowedFields: ["source", "course_id"],
            dataClass: "course",
            maxRecords: 10,
            maxBytes: 2_000,
            freeText: "deny",
            learnerTokens: false,
            artifactInspection: "deny",
          },
          morrow_legacy_only: {
            allowedFields: ["source", "tool", "value", "operation_id"],
            dataClass: "course",
            maxRecords: 10,
            maxBytes: 2_000,
            freeText: "deny",
            learnerTokens: false,
            artifactInspection: "deny",
          },
        },
      },
    ],
    filters: { excludePrefixes: [], excludeNames: [] },
    operationJournal: { path: ":memory:" },
    maxCatalogTools: 20,
  });
}

function operationId(result: JsonObject): string {
  const structured = result.structuredContent as { operationId?: unknown };
  if (typeof structured?.operationId !== "string") throw new Error("operation id missing");
  return structured.operationId;
}

describe("outer provider effects", () => {
  it("plans, separately approves, dispatches once, verifies fresh evidence, and corrects with a new operation", async () => {
    const runtime = await GatewayRuntime.connect(config(), { journalPath: ":memory:" });
    try {
      const expectedReadbackDigest = sha256Json({ source: "example-legacy", course_id: "101" });
      const planned = await runtime.call("morrow_legacy_only", {
        value: "first",
        _morrow: {
          operation_id: "operation:outer-1234",
          readback: {
            tool: "canvas_page_get",
            arguments: { course_id: "101" },
            expected_digest: expectedReadbackDigest,
          },
        },
      });
      const id = operationId(planned);
      expect(planned.structuredContent).toMatchObject({
        schema: "morrow.result.v1",
        backend: "example-legacy",
        status: "awaiting_approval",
        phase: "planned",
        completeness: "complete",
        effectState: "awaiting_approval",
        verification: { status: "unconfirmed", evidence: [] },
        attention: [],
        limitations: [],
      });
      expect(runtime.operationGet(id)).toMatchObject({
        schema: "morrow.operation.v1",
        plan: { arguments: { value: "first" } },
      });

      runtime.approveOperation(id);
      const dispatched = await runtime.dispatchOperation(id);
      expect(dispatched.structuredContent).toMatchObject({
        schema: "morrow.result.v1",
        effectState: "verified",
        verification: { status: "verified" },
        receipts: { dispatchAttempt: 1 },
      });
      const replay = await runtime.dispatchOperation(id);
      expect(replay.isError).toBe(true);

      expect(() => runtime.undoOperation(id, "morrow_legacy_only", { value: "corrected" }))
        .toThrow("no exact undo facts");
    } finally {
      await runtime.close();
    }
  }, 20_000);

  it("uses an isolated loopback approval service that is outside the MCP tool surface", async () => {
    const runtime = await MorrowRuntime.connect(config(), { statePath: ":memory:" });
    try {
      const planned = await runtime.gateway.call("morrow_legacy_only", {
        value: "approve-through-loopback",
        _morrow: {
          readback: {
            tool: "canvas_page_get",
            arguments: { course_id: "101" },
            expected_digest: sha256Json({ source: "example-legacy", course_id: "101" }),
          },
        },
      });
      const id = operationId(planned);
      const structured = planned.structuredContent as { receipts?: { approvalUrl?: unknown } };
      const url = structured.receipts?.approvalUrl;
      expect(typeof url).toBe("string");
      const view = await fetch(url as string);
      const body = await view.text();
      expect(body).toContain("Before Morrow makes changes");
      expect(body).toContain("Ready for your review");
      expect(body).toContain("Technical details");
      const nonce = /name="nonce" value="([^"]+)"/.exec(body)?.[1];
      const cookie = view.headers.get("set-cookie")?.split(";", 1)[0];
      expect(nonce).toBeTruthy();
      expect(cookie).toBeTruthy();
      const refused = await fetch(`${url}/approve`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie! },
        body: new URLSearchParams({ nonce: nonce! }),
      });
      expect(refused.status).toBe(409);
      expect(runtime.gateway.operationGet(id)).toMatchObject({ state: "awaiting_approval" });

      const refreshed = await fetch(url as string);
      const refreshedBody = await refreshed.text();
      const validNonce = /name="nonce" value="([^"]+)"/.exec(refreshedBody)?.[1];
      const validCookie = refreshed.headers.get("set-cookie")?.split(";", 1)[0];
      const approval = await fetch(`${url}/approve`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: validCookie!,
          origin: new URL(url as string).origin,
          referer: url as string,
        },
        body: new URLSearchParams({ nonce: validNonce! }),
      });
      expect(approval.status).toBe(200);
      expect(await approval.text()).not.toContain("Continue");
      await expect.poll(() => runtime.gateway.operationGet(id).state).toBe("verified");
      const settled = await fetch(url as string);
      const settledBody = await settled.text();
      expect(settledBody).toContain("Changes confirmed");
      expect(settledBody).not.toContain('<button class="approve"');
      const stale = await fetch(`${url}/approve`, {
        method: "POST",
        headers: { accept: "text/html", "content-type": "application/x-www-form-urlencoded" },
      });
      expect(stale.status).toBe(409);
      const staleBody = await stale.text();
      expect(staleBody).toContain("Review could not be completed");
      expect(staleBody).not.toContain("nonce");
    } finally {
      await runtime.close();
    }
  }, 20_000);

  it("shows a confirmed no-send failure without weakening uncertain result guidance", async () => {
    let snapshot: JsonObject = {
      operationId: "quiz-item",
      state: "awaiting_approval",
      plan: {
        tool: "canvas_update_quiz_item",
        arguments: {
          course_id: "42",
          assignment_id: "77",
          item_id: "10899365",
          item_entry_scoring_data: { value: "ribosomes" },
          _morrow: { source_binding_id: "canvas:test" },
        },
      },
    };
    const approval = new LoopbackApprovalServer({
      operationGet: () => snapshot,
      operationList: () => ({}),
      operationReviewContext: async () => ({
        targets: [
          { field: "course_id", label: "Course", name: "Intro to Biology" },
          { field: "assignment_id", label: "Quiz", name: "Cell Structure Check" },
          { field: "item_id", label: "Question", name: "Protein assembly" },
        ],
        question: {
          item_entry_title: "Protein assembly",
          item_entry_item_body: "Which structure directly assembles proteins?",
          item_entry_interaction_type_slug: "choice",
          item_entry_interaction_data: { choices: [{ id: "ribosomes", position: 1, item_body: "Ribosomes" }, { id: "mitochondria", position: 2, item_body: "Mitochondria" }] },
          item_entry_scoring_algorithm: "Equivalence",
          item_entry_scoring_data: { value: "mitochondria" },
        },
      }),
      approveOperation: () => snapshot,
      runApprovedOperation: async () => undefined,
      cancelOperation: () => snapshot,
      setApprovalBaseUrl: () => undefined,
    });
    try {
      const url = await approval.start();
      const review = await (await fetch(`${url}/operations/quiz-item`)).text();
      expect(review).toContain("Which structure directly assembles proteins?");
      expect(review).toContain("Current correct answer");
      expect(review).toContain("Proposed correct answer");
      expect(review).toContain("Only the answer key is in this request");
      expect(review).not.toContain("More question settings");

      snapshot = {
        operationId: "quiz-item",
        state: "awaiting_approval",
        plan: {
          tool: "canvas_update_quiz_item",
          arguments: {
            course_id: "42",
            assignment_id: "77",
            item_id: "10899365",
            item_entry_scoring_data: { value: "ribosomes" },
            item_points_possible: 2,
            _morrow: { source_binding_id: "canvas:test" },
          },
        },
      };
      const mixed = await (await fetch(`${url}/operations/mixed`)).text();
      expect(mixed).toContain("<strong>2</strong> points");
      expect(mixed).not.toContain("Only the answer key is in this request");

      snapshot = {
        state: "failed",
        attention: ["dispatch_failed_before_send"],
        plan: { tool: "canvas_update_create_page_courses", arguments: {} },
      };
      const noSend = await (await fetch(`${url}/operations/no-send`)).text();
      expect(noSend).toContain("No change was sent");
      expect(noSend).toContain("read the latest Canvas content and prepare a new review");
      expect(noSend).not.toContain("This request did not finish");

      snapshot = {
        state: "applied_or_unknown",
        attention: ["provider_effect_may_have_landed"],
        plan: { tool: "canvas_update_create_page_courses", arguments: {} },
      };
      const uncertain = await (await fetch(`${url}/operations/uncertain`)).text();
      expect(uncertain).toContain("Canvas may have received the changes");
      expect(uncertain).not.toContain("No change was sent");
    } finally {
      await approval.close();
    }

    let missingMove: JsonObject = {
      operationId: "moodle-move-missing",
      state: "awaiting_approval",
      plan: { tool: "moodle_move_activity", arguments: { course_id: 2, module_id: 8, target_section_id: 4, expected_digest: "e".repeat(64), _morrow: { source_binding_id: "moodle:demo:2" } } },
    };
    const missingApproval = new LoopbackApprovalServer({
      operationGet: () => missingMove,
      operationList: () => ({}),
      operationReviewContext: async () => ({ targets: [{ field: "course_id", label: "Course", name: "Biology" }, { field: "module_id", label: "Activity", name: "Evidence notebook" }, { field: "target_section_id", label: "Destination section", name: "Week 2" }] }),
      approveOperation: () => missingMove,
      runApprovedOperation: async () => undefined,
      cancelOperation: () => missingMove,
      setApprovalBaseUrl: () => undefined,
      batchApprovalGet: () => missingMove,
    });
    try {
      const url = await missingApproval.start();
      const review = await (await fetch(`${url}/operations/moodle-move-missing`)).text();
      expect(review).toContain("Morrow could not identify the course or a selected item in Moodle.");
      expect(review).not.toContain('class="approve"');
      missingMove = { ...missingMove, state: "verified" };
      const verified = await (await fetch(`${url}/operations/moodle-move-verified`)).text();
      expect(verified).not.toContain("Earlier values are not available in this review.");
    } finally {
      await missingApproval.close();
    }
  });

  it("renders Moodle browser reviews with formatted content, civil dates, and visibility decisions", async () => {
    const children = [
      {
        operation: {
          operationId: "moodle-page",
          state: "awaiting_approval",
          plan: { tool: "moodle_update_page", arguments: { course_id: 2, module_id: 6, content: "<h2>Week 1 reading</h2><script>ignored()</script>", expected_digest: "a".repeat(64), _morrow: { source_binding_id: "moodle:demo:2" } } },
        },
      },
      {
        operation: {
          operationId: "moodle-assignment",
          state: "awaiting_approval",
          plan: { tool: "moodle_update_assignment", arguments: { course_id: 2, module_id: 7, due_date: { year: 2027, month: 5, day: 14, hour: 15, minute: 45 }, expected_digest: "b".repeat(64), _morrow: { source_binding_id: "moodle:demo:2" } } },
        },
      },
      {
        operation: {
          operationId: "moodle-visibility",
          state: "awaiting_approval",
          plan: { tool: "moodle_hide_section", arguments: { course_id: 2, section_id: 3, expected_digest: "c".repeat(64), _morrow: { source_binding_id: "moodle:demo:2" } } },
        },
      },
      {
        operation: {
          operationId: "moodle-move",
          state: "awaiting_approval",
          plan: { tool: "moodle_move_activity", arguments: { course_id: 2, module_id: 8, target_section_id: 4, expected_digest: "d".repeat(64), _morrow: { source_binding_id: "moodle:demo:2" } } },
        },
      },
    ];
    const snapshot: JsonObject = { batch: { state: "planned" }, children, totalChildren: children.length };
    const contexts: Record<string, ApprovalReviewContext> = {
      "moodle-page": {
        targets: [{ field: "course_id", label: "Course", name: "Biology" }, { field: "module_id", label: "Activity", name: "Week 1 page" }],
        current: { content: "<p>Old reading</p>" },
      },
      "moodle-assignment": {
        targets: [{ field: "course_id", label: "Course", name: "Biology" }, { field: "module_id", label: "Activity", name: "Course reflection" }],
        current: { due_date: { year: 2027, month: 5, day: 7, hour: 9, minute: 0 } },
      },
      "moodle-visibility": {
        targets: [{ field: "course_id", label: "Course", name: "Biology" }, { field: "section_id", label: "Section", name: "Week 1" }],
        current: { visible: true },
      },
      "moodle-move": {
        targets: [{ field: "course_id", label: "Course", name: "Biology" }, { field: "module_id", label: "Activity", name: "Evidence notebook" }, { field: "target_section_id", label: "Destination section", name: "Week 2" }],
        current: { current_section: "Topic 1" },
      },
    };
    const approval = new LoopbackApprovalServer({
      operationGet: () => snapshot,
      operationList: () => ({}),
      operationReviewContext: async (operationId) => contexts[operationId] || { targets: [] },
      approveOperation: () => snapshot,
      runApprovedOperation: async () => undefined,
      cancelOperation: () => snapshot,
      setApprovalBaseUrl: () => undefined,
      batchApprovalGet: () => snapshot,
    });
    try {
      const url = await approval.start();
      const review = await (await fetch(`${url}/batches/moodle-review`)).text();
      const displayed = review.slice(0, review.lastIndexOf("<details><summary>Technical details"));
      expect(displayed).toContain("Update this Moodle Page");
      expect(displayed).toContain('aria-label="Page content preview"');
      expect(displayed).toContain("Week 1 reading");
      expect(displayed).not.toContain("ignored()");
      expect(displayed).toContain("May 14, 2027, 3:45 PM");
      expect(displayed).toContain("Moodle user’s configured time zone");
      expect(displayed).not.toContain("&quot;year&quot;");
      expect(displayed).toContain("Hide this Moodle section from learners");
      expect(displayed).toContain("This will hide the section and its activities from learners.");
      expect(displayed).toContain("Evidence notebook · Week 2");
      expect(displayed).toContain("Evidence notebook");
      expect(displayed).toContain("Week 2");
      expect(displayed).toContain("Current section");
      expect(displayed).toContain("Topic 1");
      expect(displayed).toContain("This moves the activity to the end of the selected destination section. Morrow checks that its visibility and access stay unchanged.");
      expect(displayed).toContain("Visible to learners");
      expect(displayed).toContain("Keep your assistant and Chrome open while Morrow works.");
    } finally {
      await approval.close();
    }
  });
});
