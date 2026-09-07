import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Json, type JsonObject } from "@morrow/contracts";
import { parseGatewayConfig } from "../src/config.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";
import { GatewayRuntime } from "../src/runtime.js";
import { LoopbackApprovalServer } from "../src/approval-server.js";
import type { ApprovalReviewContext } from "../src/approval-context.js";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url));

function config(options: { readonly delayMs?: number } = {}) {
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
        env: {
          FAKE_SOURCE: "example-legacy",
          ...(options.delayMs ? { FAKE_DELAY_MS: String(options.delayMs) } : {}),
        },
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

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("operation did not reach its expected state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

  it("blocks an overlapping target across gateway instances while independent courses dispatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-effect-target-runtime-"));
    const journalPath = join(directory, "gateway.sqlite3");
    let first: GatewayRuntime | undefined;
    let second: GatewayRuntime | undefined;
    const plan = (runtime: GatewayRuntime, value: string, courseId: string, pageId: string) => runtime.planOperation("morrow_legacy_only", {
      value,
      course_id: courseId,
      page_id: pageId,
      _morrow: {
        readback: {
          tool: "canvas_page_get",
          arguments: { course_id: courseId },
          expected_digest: sha256Json({ source: "example-legacy", course_id: courseId }),
        },
      },
    });
    try {
      first = await GatewayRuntime.connect(config({ delayMs: 150 }), { journalPath });
      second = await GatewayRuntime.connect(config({ delayMs: 150 }), { journalPath });
      const firstId = operationId(plan(first, "first request value", "101", "88"));
      const sameTargetId = operationId(plan(second, "different request value", "101", "88"));
      const distinctTargetId = operationId(plan(second, "same course different page", "101", "89"));
      const differentCourseId = operationId(plan(second, "other course value", "102", "88"));
      expect(first.operationGet(firstId).targetIdentityDigest).toBe(second.operationGet(sameTargetId).targetIdentityDigest);
      expect(first.operationGet(firstId).targetIdentityDigest).not.toBe(second.operationGet(distinctTargetId).targetIdentityDigest);
      expect(first.operationGet(firstId).targetIdentityDigest).not.toBe(second.operationGet(differentCourseId).targetIdentityDigest);
      first.approveOperation(firstId);
      second.approveOperation(sameTargetId);
      second.approveOperation(distinctTargetId);
      second.approveOperation(differentCourseId);

      const firstDispatch = first.dispatchOperation(firstId);
      await waitUntil(() => first!.operationGet(firstId).state === "dispatching");
      const overlapping = await second.dispatchOperation(sameTargetId);
      expect(overlapping).toMatchObject({ isError: true });
      expect(second.operationGet(sameTargetId)).toMatchObject({ state: "approved" });

      const sameCourseDispatch = second.dispatchOperation(distinctTargetId);
      const independentDispatch = second.dispatchOperation(differentCourseId);
      await waitUntil(() => second!.operationGet(distinctTargetId).state === "dispatching");
      await waitUntil(() => second!.operationGet(differentCourseId).state === "dispatching");
      const [firstResult, sameCourseResult, independentResult] = await Promise.all([
        firstDispatch,
        sameCourseDispatch,
        independentDispatch,
      ]);
      expect(firstResult.isError).not.toBe(true);
      expect(sameCourseResult.isError).not.toBe(true);
      expect(independentResult.isError).not.toBe(true);

      expect((await second.dispatchOperation(sameTargetId)).isError).not.toBe(true);
    } finally {
      await second?.close();
      await first?.close();
      await rm(directory, { recursive: true, force: true });
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
      expect(body).toContain('<article class="card">');
      expect(body).toContain('<header class="hero"><h1>');
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
      expect(staleBody).toContain("Review unavailable");
      expect(staleBody).not.toContain("nonce");
    } finally {
      await runtime.close();
    }
  }, 20_000);

  it("keeps raw provider data out of loopback collections and technical details", async () => {
    const learnerMarker = "learner-private-marker-734a961d";
    const ordinaryChange = "Publish the course overview for Week 2.";
    const digest = "a".repeat(64);
    const snapshot: JsonObject = {
      schema: "morrow.operation.v1",
      operationId: "op:privacy-safe-1234",
      state: "awaiting_approval",
      verificationStatus: "unconfirmed",
      dispatchAttempt: 1,
      effectReceiptId: "effect:123e4567-e89b-12d3-a456-426614174000",
      requestDigest: digest,
      planDigest: "b".repeat(64),
      plan: {
        tool: "moodle_update_page",
        hiddenLearnerMarker: learnerMarker,
        arguments: {
          course_id: 2,
          module_id: 6,
          content: ordinaryChange,
          _morrow: { learnerMarker },
        },
        readback: {
          tool: "moodle_get_page",
          arguments: { learnerMarker },
          expectedDigest: "c".repeat(64),
        },
      },
      readback: {
        tool: "moodle_get_page",
        arguments: { learnerMarker },
        expectedDigest: "c".repeat(64),
      },
      forwardedRequest: { learnerMarker },
    };
    const approval = new LoopbackApprovalServer({
      operationGet: () => snapshot,
      operationList: () => ({ schema: "morrow.operations.list.v1", returned: 1, operations: [snapshot] }),
      operationReviewContext: async () => ({
        targets: [
          { field: "course_id", label: "Course", name: "Biology" },
          { field: "module_id", label: "Activity", name: "Week 2 overview" },
        ],
      }),
      approveOperation: () => snapshot,
      runApprovedOperation: async () => undefined,
      cancelOperation: () => snapshot,
      setApprovalBaseUrl: () => undefined,
    });
    try {
      const url = await approval.start();
      const collection = await (await fetch(`${url}/operations`)).json() as JsonObject;
      const entry = (collection.operations as JsonObject[])[0]!;
      expect(collection).toMatchObject({
        schema: "morrow.approval-operations.list.v1",
        returned: 1,
        operations: [{
          operationId: "op:privacy-safe-1234",
          status: { state: "awaiting_approval", verification: "unconfirmed" },
          receipt: { dispatchAttempt: 1, effectReceiptId: "effect:123e4567-e89b-12d3-a456-426614174000" },
          digests: { requestDigest: digest, planDigest: "b".repeat(64) },
        }],
      });
      expect(entry).not.toHaveProperty("plan");
      expect(entry).not.toHaveProperty("readback");
      expect(entry).not.toHaveProperty("forwardedRequest");
      expect(JSON.stringify(collection)).not.toContain(learnerMarker);

      const review = await (await fetch(`${url}/operations/op%3Aprivacy-safe-1234`)).text();
      const technical = review.slice(review.lastIndexOf("<details><summary>Technical details</summary>"));
      expect(review).toContain(ordinaryChange);
      expect(technical).not.toContain(learnerMarker);
      expect(technical).not.toContain('"plan"');
      expect(technical).not.toContain('"arguments"');
      expect(technical).not.toContain('"forwardedRequest"');
    } finally {
      await approval.close();
    }
  });

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

      snapshot = {
        state: "approved",
        attention: ["provider_effect_target_conflict"],
        plan: { tool: "moodle_create_resource_file", arguments: {} },
      };
      const blocked = await (await fetch(`${url}/operations/blocked-target`)).text();
      expect(blocked).toContain("Check earlier change");
      expect(blocked).toContain("Morrow has not sent this change");
      expect(blocked).toContain("same target");
      expect(blocked).not.toContain("Your approval was saved, but this request is not running");

      snapshot = {
        state: "approved",
        attention: ["provider_effect_target_scope_unknown"],
        plan: { tool: "canvas_update_create_page_courses", arguments: {} },
      };
      const historicalScopeBlocked = await (await fetch(`${url}/operations/blocked-historical-scope`)).text();
      expect(historicalScopeBlocked).toContain("Check earlier change");
      expect(historicalScopeBlocked).toContain("An earlier change from an older Morrow version is still unresolved");
      expect(historicalScopeBlocked).toContain("Morrow has not sent this change");
      expect(historicalScopeBlocked).not.toContain("same target");
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
        targets: [{ field: "course_id", label: "Course", name: "Biology" }, { field: "module_id", label: "Activity", name: "Evidence notebook" }, { field: "target_section_id", label: "Destination section", name: "Section 2: New section" }],
        current: { current_section: "Section 1: New section" },
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
      expect(displayed).toContain("Edit Page");
      expect(displayed).toContain('aria-label="Content preview"');
      expect(displayed).toContain("Week 1 reading");
      expect(displayed).not.toContain("ignored()");
      expect(displayed).toContain("May 14, 2027, 3:45 PM");
      expect(displayed).toContain("Moodle user’s configured time zone");
      expect(displayed).not.toContain("&quot;year&quot;");
      expect(displayed).toContain("Hide section");
      expect(displayed).toContain("This will hide the section and its activities from learners.");
      expect(displayed).toContain("Evidence notebook · Section 2: New section");
      expect(displayed).toContain("Evidence notebook");
      expect(displayed).toContain("Section 2: New section");
      expect(displayed).toContain("<dt>From section</dt><dd>Section 1: New section</dd>");
      expect(displayed).toContain("This moves the activity to the end of the selected destination section. Morrow checks that its visibility and access stay unchanged.");
      expect(displayed).toContain("Visible to learners");
      expect(displayed).toContain("Keep your assistant and Chrome open while Morrow works.");
    } finally {
      await approval.close();
    }
  });

  it("renders gradebook rename details and withholds Apply when fresh targets are missing", async () => {
    const snapshot: JsonObject = {
      operationId: "moodle-grade-item", state: "awaiting_approval",
      plan: { tool: "moodle_update_grade_item", arguments: { course_id: 5, grade_item_id: 4, item_name: "Morrow gradebook check renamed", expected_digest: "a".repeat(64), _morrow: { source_binding_id: "moodle:demo:5" } } },
    };
    let context: ApprovalReviewContext = {
      targets: [{ field: "course_id", label: "Course", name: "Moodle Biology" }, { field: "grade_item_id", label: "Manual grade item", name: "Morrow gradebook check" }],
      current: { gradebook_current_name: "Morrow gradebook check" },
    };
    const approval = new LoopbackApprovalServer({
      operationGet: () => snapshot,
      operationList: () => ({}),
      operationReviewContext: async () => context,
      approveOperation: () => snapshot,
      runApprovedOperation: async () => undefined,
      cancelOperation: () => snapshot,
      setApprovalBaseUrl: () => undefined,
    });
    try {
      const url = await approval.start();
      const review = await (await fetch(`${url}/operations/moodle-grade-item`)).text();
      expect(review).toContain("Rename grade item?");
      expect(review).toContain("Moodle Biology");
      expect(review).toContain("Morrow gradebook check");
      expect(review).toContain("<dt>Current name</dt><dd>Morrow gradebook check</dd>");
      expect(review).toContain("<dt>New name</dt><dd>Morrow gradebook check renamed</dd>");
      expect(review).toContain("does not read or change learner grades or grade values");
      expect(review).toContain('class="approve"');

      context = { targets: [] };
      const blocked = await (await fetch(`${url}/operations/moodle-grade-item`)).text();
      expect(blocked).toContain("Morrow could not identify the course or a selected item in Moodle.");
      expect(blocked).not.toContain('class="approve"');
    } finally {
      await approval.close();
    }
  });
});
