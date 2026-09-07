import { describe, expect, it } from "vitest";
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
function approvalServer(review: JsonObject, approved: JsonObject = review): LoopbackApprovalServer {
  return new LoopbackApprovalServer({
    operationGet: () => review,
    operationList: () => ({ schema: "morrow.operations.list.v1", returned: 1, operations: [review] }),
    operationReviewContext: async () => ({
      targets: [
        { field: "course_id", label: "Course", name: "Biology 101" },
        { field: "module_id", label: "Page", name: "Week 2 overview" },
      ],
    }),
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

describe("approval page copy", () => {
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
});
