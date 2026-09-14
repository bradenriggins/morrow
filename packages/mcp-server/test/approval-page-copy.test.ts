import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import type { JsonObject } from "@morrow/contracts";
import { LoopbackApprovalServer } from "../src/approval-server.js";

const operationId = "op:platform-copy-1234";
const encodedId = encodeURIComponent(operationId);

function moodleSnapshot(state: string): JsonObject {
  return {
    schema: "morrow.operation.v1",
    operationId,
    state,
    verificationStatus: "unconfirmed",
    dispatchAttempt: 0,
    approvalExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    plan: {
      tool: "moodle_update_page",
      arguments: { course_id: 2, module_id: 6, content: "Publish the Week 2 overview." },
    },
  };
}

/**
 * One approval server for a single Moodle change. `approved` is what the approve
 * call answers with, which is how a request that can no longer be approved
 * reaches the state page.
 */
function approvalServer(
  review: JsonObject,
  approved: JsonObject = review,
  targets: { field: string; label: string; name: string }[] = [
    { field: "course_id", label: "Course", name: "Biology 101" },
    { field: "module_id", label: "Page", name: "Week 2 overview" },
  ],
): LoopbackApprovalServer {
  return new LoopbackApprovalServer({
    operationGet: () => review,
    operationList: () => ({ schema: "morrow.operations.list.v1", returned: 1, operations: [review] }),
    operationReviewContext: async () => ({ targets }),
    approveOperation: () => approved,
    runApprovedOperation: async () => undefined,
    cancelOperation: () => review,
    setApprovalBaseUrl: () => undefined,
  });
}

/** Reads the review page and returns the nonce and cookie an approval post needs. */
async function reviewPage(baseUrl: string): Promise<{ body: string; nonce: string; cookie: string }> {
  const response = await fetch(`${baseUrl}/operations/${encodedId}`);
  const body = await response.text();
  return {
    body,
    nonce: /name="nonce" value="([^"]+)"/.exec(body)?.[1] || "",
    cookie: response.headers.get("set-cookie")?.split(";", 1)[0] || "",
  };
}

async function submitApproval(baseUrl: string, nonce: string, cookie: string): Promise<Response> {
  return fetch(`${baseUrl}/operations/${encodedId}/approve`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html",
      cookie,
      origin: baseUrl,
      referer: `${baseUrl}/operations/${encodedId}`,
    },
    body: new URLSearchParams({ nonce }),
    redirect: "manual",
  });
}

function trackedApprovalServer(approvals: { count: number }): LoopbackApprovalServer {
  const snapshot = moodleSnapshot("awaiting_approval");
  return new LoopbackApprovalServer({
    operationGet: () => snapshot,
    operationList: () => ({ schema: "morrow.operations.list.v1", returned: 1, operations: [snapshot] }),
    operationReviewContext: async () => ({ targets: [
      { field: "course_id", label: "Course", name: "Biology 101" },
      { field: "module_id", label: "Page", name: "Week 2 overview" },
    ] }),
    approveOperation: () => {
      approvals.count += 1;
      return moodleSnapshot("approved");
    },
    runApprovedOperation: async () => undefined,
    cancelOperation: () => moodleSnapshot("cancelled"),
    setApprovalBaseUrl: () => undefined,
  });
}

describe("approval page copy", () => {
  it("bounds a stalled status request and schedules an automatic recovery read", async () => {
    const server = approvalServer(moodleSnapshot("applied_or_unknown"));
    try {
      const baseUrl = await server.start();
      const script = await (await fetch(`${baseUrl}/review-status.js`)).text();
      const status = { innerHTML: "Waiting", textContent: "Waiting" };
      const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
      const context = {
        AbortController,
        location: { pathname: `/operations/${encodedId}` },
        document: {
          body: { dataset: { polling: "true" } },
          querySelector: () => null,
          querySelectorAll: () => [],
          getElementById: (id: string) => id === "work-status" ? status : null,
        },
        fetch: (_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("stalled response aborted")), { once: true });
        }),
        setTimeout: (callback: () => void, delay: number) => {
          const timer = { callback, delay, cleared: false };
          timers.push(timer);
          return timer;
        },
        clearTimeout: (timer: { cleared: boolean } | undefined) => { if (timer) timer.cleared = true; },
      };

      runInNewContext(script, context);
      expect(timers).toHaveLength(1);
      expect(timers[0]?.delay).toBe(5000);
      timers[0]?.callback();
      await new Promise((resolve) => setImmediate(resolve));

      expect(status.textContent).toContain("cannot refresh this result");
      expect(timers).toHaveLength(2);
      expect(timers[1]?.delay).toBe(5000);
      expect(timers[0]?.cleared).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("keeps an earlier review page valid after the same review opens again", async () => {
    const approvals = { count: 0 };
    const server = trackedApprovalServer(approvals);
    try {
      const baseUrl = await server.start();
      const first = await reviewPage(baseUrl);
      const second = await reviewPage(baseUrl);
      expect(first.nonce).not.toBe(second.nonce);
      expect(first.cookie.split("=", 1)[0]).not.toBe(second.cookie.split("=", 1)[0]);
      await expect(submitApproval(baseUrl, first.nonce, first.cookie)).resolves.toMatchObject({ status: 303 });
      expect(approvals.count).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("an invalid page grant cannot erase another valid grant", async () => {
    const approvals = { count: 0 };
    const server = trackedApprovalServer(approvals);
    try {
      const baseUrl = await server.start();
      const first = await reviewPage(baseUrl);
      const second = await reviewPage(baseUrl);
      await expect(submitApproval(baseUrl, first.nonce, second.cookie)).resolves.toMatchObject({ status: 409 });
      expect(approvals.count).toBe(0);
      await expect(submitApproval(baseUrl, second.nonce, second.cookie)).resolves.toMatchObject({ status: 303 });
      expect(approvals.count).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("names the platform the change is for, and no other", async () => {
    const server = approvalServer(moodleSnapshot("applied_or_unknown"));
    try {
      const baseUrl = await server.start();
      const page = await (await fetch(`${baseUrl}/operations/${encodedId}`)).text();
      expect(page).toContain("<h1>Result unconfirmed</h1>");
      expect(page).toContain("Moodle may have received the changes.");
      expect(page).toContain("open the item in Moodle and confirm it yourself");
      expect(page).not.toContain("Canvas");
    } finally {
      await server.close();
    }
  });

  it("keeps the platform of the request when an approval can no longer be taken", async () => {
    const server = approvalServer(moodleSnapshot("awaiting_approval"), moodleSnapshot("applied_or_unknown"));
    try {
      const baseUrl = await server.start();
      const { nonce, cookie } = await reviewPage(baseUrl);
      expect(nonce).not.toBe("");
      const refused = await fetch(`${baseUrl}/operations/${encodedId}/approve`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "text/html",
          cookie,
          origin: baseUrl,
          referer: `${baseUrl}/operations/${encodedId}`,
        },
        body: new URLSearchParams({ nonce }),
        redirect: "manual",
      });
      expect(refused.status).toBe(409);
      const page = await refused.text();
      expect(page).toContain("<h1>Result unconfirmed</h1>");
      expect(page).toContain("Moodle may have received the changes.");
      expect(page).not.toContain("Canvas");
    } finally {
      await server.close();
    }
  });

  it("names no platform when the request behind the page cannot be read", async () => {
    const server = approvalServer(moodleSnapshot("awaiting_approval"));
    try {
      const baseUrl = await server.start();
      const refused = await fetch(`${baseUrl}/operations/${encodedId}/approve`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "text/html",
          cookie: "morrow_approval=not-the-nonce",
        },
        body: new URLSearchParams({ nonce: "not-the-nonce" }),
        redirect: "manual",
      });
      expect(refused.status).toBe(409);
      const page = await refused.text();
      expect(page).toContain("<h1>Review unavailable</h1>");
      expect(page).toContain("Do not repeat the change until Morrow checks the saved result.");
      expect(page).not.toMatch(/Canvas|Moodle|Blackboard/);
    } finally {
      await server.close();
    }
  });

  it("gives the review card the name of its heading and no second name", async () => {
    const server = approvalServer(moodleSnapshot("awaiting_approval"));
    try {
      const baseUrl = await server.start();
      const { body } = await reviewPage(baseUrl);
      expect(body).toContain('<article class="card">');
      expect(body).toContain("<h1>Edit Page?</h1>");
      expect(body.match(/<h1/g)).toHaveLength(1);
      expect(body).not.toContain("aria-label=\"Before Morrow makes changes\"");
    } finally {
      await server.close();
    }
  });

  it("shows New Quiz settings with instructor-facing labels and no internal hashes", async () => {
    const internalHash = "a".repeat(64);
    const snapshot: JsonObject = {
      ...moodleSnapshot("awaiting_approval"),
      requestDigest: internalHash,
      planDigest: internalHash,
      plan: {
        tool: "canvas_update_single_quiz",
        arguments: {
          course_id: "42",
          assignment_id: "77",
          quiz_quiz_settings_shuffle_answers: true,
          quiz_quiz_settings_session_time_limit_in_seconds: 900,
          expected_digest: internalHash,
          morrow_new_quiz_settings_guard: { current_quiz_settings_sha256: internalHash },
          _morrow: { source_binding_id: "canvas:instructor" },
        },
      },
    };
    const server = approvalServer(snapshot, snapshot, [
      { field: "course_id", label: "Course", name: "Biology 101" },
      { field: "assignment_id", label: "New Quiz", name: "Cell structure check" },
    ]);
    try {
      const baseUrl = await server.start();
      const { body } = await reviewPage(baseUrl);
      expect(body).toContain("Shuffle answers");
      expect(body).toContain("Time limit in seconds");
      expect(body).not.toContain("morrow_new_quiz_settings_guard");
      expect(body).not.toContain(internalHash);
    } finally {
      await server.close();
    }
  });

  it("shows Blackboard course copy source and destination labels without an internal plan hash", async () => {
    const internalHash = "b".repeat(64);
    const snapshot: JsonObject = {
      ...moodleSnapshot("awaiting_approval"),
      requestDigest: internalHash,
      planDigest: internalHash,
      plan: {
        tool: "blackboard_apply_reviewed_course_copy",
        arguments: {
          tenant_id: "tenant:college",
          source_binding_id: "blackboard:instructor",
          course_id: "COURSE-101",
          destination_course_id: "COURSE-101-COPY",
          expected_plan_digest: internalHash,
          expected_connection: { principal_fingerprint: internalHash, session_generation: 1 },
          _morrow: { source_binding_id: "blackboard:instructor" },
        },
      },
    };
    const server = approvalServer(snapshot, snapshot, []);
    try {
      const baseUrl = await server.start();
      const { body } = await reviewPage(baseUrl);
      expect(body).toContain("<h1>Copy Blackboard course?</h1>");
      expect(body).toContain("<dt>Source Course ID</dt><dd>COURSE-101</dd>");
      expect(body).toContain("<dt>New Course ID</dt><dd>COURSE-101-COPY</dd>");
      expect(body).toContain('class="approve"');
      expect(body).not.toContain(internalHash);
    } finally {
      await server.close();
    }
  });
});
