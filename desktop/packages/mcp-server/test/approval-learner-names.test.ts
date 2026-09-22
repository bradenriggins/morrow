import { describe, expect, it } from "vitest";
import type { JsonObject } from "@morrow/contracts";
import { LoopbackApprovalServer, type ApprovalOperationController } from "../src/approval-server.js";

/**
 * The review server is plain local HTTP. Any program on this computer can read it, and that
 * includes an assistant that can run shell commands. So every page and every JSON answer it
 * serves names learners by label only. The name behind each label reaches the educator only
 * through Morrow Bridge: the server hands the label map to the runtime, which sends it over the
 * paired, authenticated Bridge connection, and the Bridge shows it in the review tab.
 */

const operationId = "op:learner-names-1234";
const batchId = "batch-learner-names-1234";
const REAL_NAMES = ["Jane", "Doe", "Rivera"];

function snapshot(state: string, id = operationId): JsonObject {
  return {
    schema: "morrow.operation.v1",
    operationId: id,
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

type Shared = { readonly path: string; readonly names: Readonly<Record<string, string>> | null };

function server(state: string, learnerNames?: Record<string, string>, shared: Shared[] = []): LoopbackApprovalServer {
  const review = snapshot(state);
  const child = (index: number) => ({ index, operation: { ...snapshot(state, `op:learner-names-child-${index}`) } });
  const batchState = state === "verified" ? "completed" : state === "awaiting_approval" || state === "approved" ? "planned" : state;
  const batch = { batch: { state: batchState, batchId }, children: [child(0), child(1)], totalChildren: 2, confirmedChildren: state === "verified" ? 2 : 0 };
  const controller: ApprovalOperationController & { setReviewLearnerNames: (path: string, names: Readonly<Record<string, string>> | null) => void } = {
    operationGet: () => review,
    operationList: () => ({ schema: "morrow.operations.list.v1", returned: 1, operations: [review] }),
    operationReviewContext: async () => ({
      targets: [
        { field: "course_id", label: "Course", name: "Biology 101" },
        { field: "assignment_id", label: "Assignment", name: "Essay 2" },
      ],
      ...(learnerNames ? { learnerNames } : {}),
    }),
    approveOperation: () => ({ ...review, state: "approved" }),
    runApprovedOperation: async () => undefined,
    cancelOperation: () => ({ ...review, state: "cancelled" }),
    setApprovalBaseUrl: () => undefined,
    setApprovalPresence: () => undefined,
    announceApprovalPresence: () => undefined,
    batchApprovalGet: () => batch,
    batchApprovalStatus: () => ({ ...batch, states: { 0: "In progress", 1: "In progress" } }),
    approveBatch: () => batch,
    runApprovedBatch: async () => undefined,
    cancelBatchApproval: () => batch,
    setReviewLearnerNames: (path, names) => { shared.push({ path, names: names ? { ...names } : null }); },
  };
  return new LoopbackApprovalServer(controller);
}

/** Everything a plain HTTP client with no cookie and no Bridge can read from the server. */
async function readEverything(baseUrl: string): Promise<string[]> {
  const bodies: string[] = [];
  const read = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${baseUrl}${path}`, { redirect: "manual", ...init });
    bodies.push(`${path} ${response.status} ${JSON.stringify([...response.headers])} ${await response.text()}`);
    return response;
  };
  for (const kind of ["operations", "batches"] as const) {
    const id = encodeURIComponent(kind === "operations" ? operationId : batchId);
    const page = await read(`/${kind}/${id}`, { headers: { accept: "text/html" } });
    await read(`/${kind}/${id}`, { headers: { accept: "application/json" } });
    await read(`/${kind}/${id}/status`);
    const cookie = String(page.headers.get("set-cookie") || "").split(";")[0] || "";
    const nonce = /name="nonce" value="([^"]+)"/u.exec(bodies.at(-3) || "")?.[1] || "";
    for (const action of ["approve", "cancel"]) {
      await read(`/${kind}/${id}/${action}`, {
        method: "POST",
        headers: { origin: baseUrl, referer: `${baseUrl}/${kind}/${id}`, cookie, accept: "text/html", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ nonce, presence: "A".repeat(43) }),
      });
    }
  }
  await read("/operations");
  await read("/recent");
  await read("/review-status.js");
  return bodies;
}

describe("student names and the local review server", () => {
  it("a plain HTTP client finds no real name on any endpoint, in any review state", async () => {
    for (const state of ["awaiting_approval", "approved", "dispatching", "running", "verified", "failed", "cancelled"]) {
      const review = server(state, { "Student A1": "Jane Doe", "Student A2": "Ana Rivera" });
      const baseUrl = await review.start();
      try {
        const bodies = await readEverything(baseUrl);
        for (const body of bodies) {
          for (const name of REAL_NAMES) expect(body, `${state}: ${body.slice(0, 160)}`).not.toContain(name);
        }
        expect(bodies.join("\n")).toContain("Student A1");
      } finally { await review.close(); }
    }
  });

  it("hands the names to the runtime for Morrow Bridge, keyed to the review path, and keeps the page on labels", async () => {
    const shared: Shared[] = [];
    const review = server("awaiting_approval", { "Student A1": "Jane <Doe>" }, shared);
    const baseUrl = await review.start();
    try {
      const body = await (await fetch(`${baseUrl}/operations/${encodeURIComponent(operationId)}`)).text();
      expect(body).toContain("Extension for Student A1 &lt;b&gt;");
      expect(body).not.toContain("Jane");
      expect(shared).toEqual([{ path: `/operations/${operationId}`, names: { "Student A1": "Jane <Doe>" } }]);
    } finally { await review.close(); }
  });

  it("hands names for a finished result when the status poll shows it, and none once the review is cancelled", async () => {
    const verifiedShared: Shared[] = [];
    const verified = server("verified", { "Student A1": "Jane Doe" }, verifiedShared);
    const verifiedUrl = await verified.start();
    try {
      const status = await (await fetch(`${verifiedUrl}/operations/${encodeURIComponent(operationId)}/status`)).text();
      expect(status).not.toContain("Jane");
      expect(verifiedShared).toEqual([{ path: `/operations/${operationId}`, names: { "Student A1": "Jane Doe" } }]);
    } finally { await verified.close(); }
    const cancelledShared: Shared[] = [];
    const cancelled = server("cancelled", { "Student A1": "Jane Doe" }, cancelledShared);
    const cancelledUrl = await cancelled.start();
    try {
      await (await fetch(`${cancelledUrl}/operations/${encodeURIComponent(operationId)}`)).text();
      expect(cancelledShared).toEqual([{ path: `/operations/${operationId}`, names: null }]);
    } finally { await cancelled.close(); }
  });

  it("hands no names when the review has none for its labels", async () => {
    const shared: Shared[] = [];
    const review = server("awaiting_approval", undefined, shared);
    const baseUrl = await review.start();
    try {
      const body = await (await fetch(`${baseUrl}/operations/${encodeURIComponent(operationId)}`)).text();
      expect(body).toContain("Extension for Student A1");
      expect(shared).toEqual([{ path: `/operations/${operationId}`, names: null }]);
    } finally { await review.close(); }
  });
});
