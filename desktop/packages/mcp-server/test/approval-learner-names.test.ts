import { describe, expect, it } from "vitest";
import type { JsonObject } from "@morrow/contracts";
import { LoopbackApprovalServer } from "../src/approval-server.js";

const operationId = "op:learner-names-1234";

function snapshot(state: string): JsonObject {
  return {
    schema: "morrow.operation.v1",
    operationId,
    state,
    verificationStatus: state === "verified" ? "verified" : "unconfirmed",
    dispatchAttempt: 0,
    approvalExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    plan: {
      tool: "canvas_create_assignment_override",
      arguments: { course_id: "2", assignment_id: "9", student_ids: ["Student A1"], title: "Extension for Student A1 <b>" },
    },
  };
}

function server(state: string, learnerNames?: Record<string, string>): LoopbackApprovalServer {
  const review = snapshot(state);
  return new LoopbackApprovalServer({
    operationGet: () => review,
    operationList: () => ({ schema: "morrow.operations.list.v1", returned: 1, operations: [review] }),
    operationReviewContext: async () => ({
      targets: [
        { field: "course_id", label: "Course", name: "Biology 101" },
        { field: "assignment_id", label: "Assignment", name: "Essay 2" },
      ],
      ...(learnerNames ? { learnerNames } : {}),
    }),
    approveOperation: () => review,
    runApprovedOperation: async () => undefined,
    cancelOperation: () => review,
    setApprovalBaseUrl: () => undefined,
  });
}

describe("student names on the educator's review page", () => {
  it("shows the real name beside each label on the review page and the status poll", async () => {
    const review = server("awaiting_approval", { "Student A1": "Jane <Doe>" });
    const baseUrl = await review.start();
    try {
      const body = await (await fetch(`${baseUrl}/operations/${encodeURIComponent(operationId)}`)).text();
      expect(body).toContain("Extension for Jane &lt;Doe&gt; (Student A1)");
      expect(body).not.toMatch(/Jane <Doe>/u);
      expect(body).not.toMatch(/(?<!\()Student A1(?!\))/u);
    } finally { await review.close(); }
    const result = server("verified", { "Student A1": "Jane Doe" });
    const resultUrl = await result.start();
    try {
      const status = await (await fetch(`${resultUrl}/operations/${encodeURIComponent(operationId)}/status`)).json() as JsonObject;
      expect(JSON.stringify(status)).not.toMatch(/(?<!\()Student A1(?!\))/u);
    } finally { await result.close(); }
  });

  it("leaves labels as they are when the review has no names for them", async () => {
    const review = server("awaiting_approval");
    const baseUrl = await review.start();
    try {
      const body = await (await fetch(`${baseUrl}/operations/${encodeURIComponent(operationId)}`)).text();
      expect(body).toContain("Extension for Student A1");
    } finally { await review.close(); }
  });
});
