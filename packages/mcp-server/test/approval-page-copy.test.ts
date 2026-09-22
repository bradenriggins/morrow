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
  targets: { field: string; label: string; name: string; url?: string }[] = [
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
async function reviewPage(baseUrl: string, id = operationId): Promise<{ body: string; nonce: string; cookie: string }> {
  const response = await fetch(`${baseUrl}/operations/${encodeURIComponent(id)}`);
  const body = await response.text();
  return {
    body,
    nonce: /name="nonce" value="([^"]+)"/.exec(body)?.[1] || "",
    cookie: response.headers.get("set-cookie")?.split(";", 1)[0] || "",
  };
}

async function submitApproval(baseUrl: string, nonce: string, cookie: string, id = operationId): Promise<Response> {
  const encoded = encodeURIComponent(id);
  return fetch(`${baseUrl}/operations/${encoded}/approve`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html",
      cookie,
      origin: baseUrl,
      referer: `${baseUrl}/operations/${encoded}`,
    },
    body: new URLSearchParams({ nonce }),
    redirect: "manual",
  });
}

/** One server whose reviews are addressed by operation id, so many stay open at once. */
function manyReviewServer(approved: string[]): LoopbackApprovalServer {
  const snapshot = (id: string, state: string): JsonObject => ({ ...moodleSnapshot(state), operationId: id });
  return new LoopbackApprovalServer({
    operationGet: (id) => snapshot(id, "awaiting_approval"),
    operationList: () => ({ schema: "morrow.operations.list.v1", returned: 0, operations: [] }),
    operationReviewContext: async () => ({ targets: [
      { field: "course_id", label: "Course", name: "Biology 101" },
      { field: "module_id", label: "Page", name: "Week 2 overview" },
    ] }),
    approveOperation: (id) => {
      approved.push(id);
      return snapshot(id, "approved");
    },
    runApprovedOperation: async () => undefined,
    cancelOperation: (id) => snapshot(id, "cancelled"),
    setApprovalBaseUrl: () => undefined,
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

/**
 * One approval server for the WI-4.4 "do not ask again" button and grant. `offer` stands in for
 * `runtime.ts`'s `rememberOffer` (null when the change is not rememberable, for example a
 * removal); `grant` stands in for `rememberKind`, called only after approval succeeds.
 */
function rememberApprovalServer(
  offer: { categoryId: string; label: string; until: number } | null,
  grant: () => Promise<"saved" | "failed">,
  base: JsonObject = moodleSnapshot("awaiting_approval"),
): LoopbackApprovalServer {
  let state = String(base.state);
  return new LoopbackApprovalServer({
    operationGet: () => ({ ...base, state }),
    operationList: () => ({ schema: "morrow.operations.list.v1", returned: 1, operations: [{ ...base, state }] }),
    operationReviewContext: async () => ({ targets: [
      { field: "course_id", label: "Course", name: "Biology 101" },
      { field: "module_id", label: "Page", name: "Week 2 overview" },
    ] }),
    approveOperation: () => { state = "approved"; return { ...base, state }; },
    runApprovedOperation: async () => undefined,
    cancelOperation: () => { state = "cancelled"; return { ...base, state }; },
    setApprovalBaseUrl: () => undefined,
    rememberOffer: async () => offer,
    rememberKind: grant,
  });
}

/** Polls a review's page for `text`, without hammering the loopback server. */
async function pollForText(url: string, text: string, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let html = "";
  do {
    html = await (await fetch(url)).text();
    if (html.includes(text)) return html;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return html;
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

  it("keeps a review page valid after many other reviews are opened", async () => {
    const approved: string[] = [];
    const server = manyReviewServer(approved);
    try {
      const baseUrl = await server.start();
      const first = await reviewPage(baseUrl, operationId);
      const others = [];
      for (let index = 0; index < 128; index += 1) others.push(await reviewPage(baseUrl, `${operationId}-other-${index}`));
      await expect(submitApproval(baseUrl, first.nonce, first.cookie, operationId)).resolves.toMatchObject({ status: 303 });
      expect(approved).toEqual([operationId]);
      expect(others.at(-2)?.nonce).not.toBe("");
      expect(others.at(-1)?.nonce).toBe("");
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

  it("never shows a structural ID or URL slug field, even when the review context resolves no target for it", async () => {
    const snapshot: JsonObject = {
      ...moodleSnapshot("awaiting_approval"),
      plan: {
        tool: "canvas_delete_page_courses",
        arguments: { course_id: "42", url_or_id: "week-2-overview" },
      },
    };
    const server = approvalServer(snapshot, snapshot, []);
    try {
      const baseUrl = await server.start();
      const { body } = await reviewPage(baseUrl);
      expect(body).toContain("<h1>Remove a page in a course?</h1>");
      expect(body).not.toContain("URL or ID");
      expect(body).not.toContain("week-2-overview");
      expect(body).not.toContain("<dt>Course ID</dt>");
    } finally {
      await server.close();
    }
  });

  it("titles a Canvas change from the catalog's plain label, not the raw tool name", async () => {
    const snapshot: JsonObject = {
      ...moodleSnapshot("awaiting_approval"),
      plan: {
        tool: "canvas_update_topic_courses",
        arguments: { course_id: "42", topic_id: "9" },
      },
    };
    const server = approvalServer(snapshot, snapshot, [
      { field: "course_id", label: "Course", name: "Biology 101" },
    ]);
    try {
      const baseUrl = await server.start();
      const { body } = await reviewPage(baseUrl);
      expect(body).toContain("<h1>Edit a topic in a course?</h1>");
      expect(body).not.toContain("<h1>Edit discussion?</h1>");
    } finally {
      await server.close();
    }
  });

  it("falls back to the tool name's own words when the catalog has no plain label for it", async () => {
    const snapshot: JsonObject = {
      ...moodleSnapshot("awaiting_approval"),
      plan: {
        tool: "canvas_not_a_real_catalog_tool",
        arguments: { course_id: "42" },
      },
    };
    const server = approvalServer(snapshot, snapshot, [
      { field: "course_id", label: "Course", name: "Biology 101" },
    ]);
    try {
      const baseUrl = await server.start();
      const { body } = await reviewPage(baseUrl);
      expect(body).toContain("<h1>Not a real catalog tool?</h1>");
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

  it("gives a confirmed result the success mark, the item, and where to go next", async () => {
    const server = approvalServer(moodleSnapshot("verified"));
    try {
      const baseUrl = await server.start();
      const page = await (await fetch(`${baseUrl}/operations/${encodedId}`)).text();
      expect(page).toContain('<section class="outcome outcome-success">');
      expect(page).toContain('<svg class="success-mark"');
      expect(page).toContain("<h1>Moodle saved the change. Morrow checked the result.</h1>");
      expect(page).toContain('<p class="result-item">Week 2 overview</p>');
      expect(page).toContain("Return to your assistant. It continues on its own.");
      expect(page).toContain('<a href="/recent">See recent changes</a>');
      expect(page).not.toContain("Open in Moodle");
    } finally {
      await server.close();
    }
  });

  it("links a confirmed result to the item's platform address when the review context read one", async () => {
    const server = approvalServer(moodleSnapshot("verified"), undefined, [
      { field: "course_id", label: "Course", name: "Biology 101" },
      { field: "module_id", label: "Page", name: "Week 2 overview", url: "https://moodle.example/mod/page/view.php?id=6" },
    ]);
    try {
      const baseUrl = await server.start();
      const page = await (await fetch(`${baseUrl}/operations/${encodedId}`)).text();
      expect(page).toContain('<a href="https://moodle.example/mod/page/view.php?id=6" target="_blank" rel="noopener noreferrer">Open in Moodle</a>');
    } finally {
      await server.close();
    }
  });

  it("gives the live status poll the same item name and link as the full page", async () => {
    const server = approvalServer(moodleSnapshot("verified"), undefined, [
      { field: "course_id", label: "Course", name: "Biology 101" },
      { field: "module_id", label: "Page", name: "Week 2 overview", url: "https://moodle.example/mod/page/view.php?id=6" },
    ]);
    try {
      const baseUrl = await server.start();
      const response = await fetch(`${baseUrl}/operations/${encodedId}/status`);
      const body = (await response.json()) as { html: string };
      expect(body.html).toContain('<p class="result-item">Week 2 overview</p>');
      expect(body.html).toContain('<a href="https://moodle.example/mod/page/view.php?id=6" target="_blank" rel="noopener noreferrer">Open in Moodle</a>');
    } finally {
      await server.close();
    }
  });

  it("never shows the success mark for a result that is not confirmed", async () => {
    const server = approvalServer(moodleSnapshot("applied_or_unknown"));
    try {
      const baseUrl = await server.start();
      const page = await (await fetch(`${baseUrl}/operations/${encodedId}`)).text();
      expect(page).not.toContain("outcome-success");
      expect(page).not.toContain("success-mark");
    } finally {
      await server.close();
    }
  });

  it("marks a removal review as dangerous and names the exact object in the approve button", async () => {
    const snapshot: JsonObject = {
      ...moodleSnapshot("awaiting_approval"),
      plan: {
        tool: "canvas_delete_page_courses",
        arguments: { course_id: "42", url_or_id: "old-syllabus-draft" },
        risk: { approvalClass: "destructive" },
      },
    };
    const server = approvalServer(snapshot, snapshot, [
      { field: "course_id", label: "Course", name: "Biology 101" },
      { field: "url_or_id", label: "Page", name: "Old Syllabus Draft" },
    ]);
    try {
      const baseUrl = await server.start();
      const { body } = await reviewPage(baseUrl);
      expect(body).toContain('<header class="hero danger">');
      expect(body).toContain('<button class="approve danger" type="submit">Delete "Old Syllabus Draft"</button>');
      expect(body).not.toContain("autofocus");
    } finally {
      await server.close();
    }
  });

  it("does not mark an ordinary edit review as dangerous", async () => {
    const server = approvalServer(moodleSnapshot("awaiting_approval"));
    try {
      const baseUrl = await server.start();
      const { body } = await reviewPage(baseUrl);
      expect(body).toContain('<header class="hero">');
      expect(body).not.toContain("hero danger");
      expect(body).toContain('<button class="approve" type="submit">Apply this change</button>');
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

describe("WI-4.4: the review page's second button", () => {
  it("offers 'do not ask again' with the bundle label and the clock time, in the same form as approve", async () => {
    const until = Date.now() + 4 * 60 * 60_000;
    const clock = new Date(until).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const server = rememberApprovalServer({ categoryId: "text", label: "Text and titles", until }, async () => "saved");
    try {
      const baseUrl = await server.start();
      const { body } = await reviewPage(baseUrl);
      expect(body).toContain(`<form method="post" action="/operations/${encodedId}/approve">`);
      expect(body).toContain(`<button name="remember" value="1" class="approve secondary" type="submit">Apply this change, and do not ask again for text and titles in this course until ${clock}</button>`);
      // The remember button is inside the same <form> as the primary approve button, not a
      // second form, so one submit sends both the approval and the remembered choice.
      const form = /<form method="post" action="\/operations\/[^"]+\/approve">.*?<\/form>/s.exec(body)?.[0] ?? "";
      expect(form).toContain('<button class="approve" type="submit">Apply this change</button>');
      expect(form).toContain('name="remember" value="1"');
    } finally {
      await server.close();
    }
  });

  it("shows no second button for a removal, because rememberOffer never offers one", async () => {
    const snapshot: JsonObject = {
      ...moodleSnapshot("awaiting_approval"),
      plan: {
        tool: "canvas_delete_page_courses",
        arguments: { course_id: "42", url_or_id: "old-syllabus-draft" },
        risk: { approvalClass: "destructive" },
      },
    };
    const server = rememberApprovalServer(null, async () => "failed", snapshot);
    try {
      const baseUrl = await server.start();
      const { body } = await reviewPage(baseUrl);
      expect(body).not.toContain('name="remember"');
      expect(body).not.toContain("do not ask again");
    } finally {
      await server.close();
    }
  });

  it("remembers the kind after approval and shows the saved sentence, without delaying the change", async () => {
    const until = Date.now() + 4 * 60 * 60_000;
    const clock = new Date(until).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    let grantCalled = false;
    const server = rememberApprovalServer({ categoryId: "text", label: "Text and titles", until }, async () => {
      grantCalled = true;
      return "saved";
    });
    try {
      const baseUrl = await server.start();
      const { nonce, cookie } = await reviewPage(baseUrl);
      const approve = await fetch(`${baseUrl}/operations/${encodedId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html", cookie, origin: baseUrl, referer: `${baseUrl}/operations/${encodedId}` },
        body: new URLSearchParams({ nonce, remember: "1" }),
        redirect: "manual",
      });
      // Approve first: the redirect that starts the change does not wait on the grant.
      expect(approve.status).toBe(303);
      const html = await pollForText(`${baseUrl}/operations/${encodedId}`, "does not ask again");
      expect(grantCalled).toBe(true);
      expect(html).toContain(`Morrow does not ask again for text and titles in this course until ${clock}.`);
    } finally {
      await server.close();
    }
  });

  it("runs the change even when the remembered grant fails, and says so", async () => {
    const server = rememberApprovalServer({ categoryId: "text", label: "Text and titles", until: Date.now() + 4 * 60 * 60_000 }, async () => "failed");
    try {
      const baseUrl = await server.start();
      const { nonce, cookie } = await reviewPage(baseUrl);
      const approve = await fetch(`${baseUrl}/operations/${encodedId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html", cookie, origin: baseUrl, referer: `${baseUrl}/operations/${encodedId}` },
        body: new URLSearchParams({ nonce, remember: "1" }),
        redirect: "manual",
      });
      expect(approve.status).toBe(303);
      const html = await pollForText(`${baseUrl}/operations/${encodedId}`, "could not save that choice");
      expect(html).toContain("Morrow could not save that choice. It asks again next time.");
    } finally {
      await server.close();
    }
  });

  it("refuses remember=1 with a wrong nonce the same way an ordinary approval is refused", async () => {
    let grantCalled = false;
    const server = rememberApprovalServer({ categoryId: "text", label: "Text and titles", until: Date.now() + 4 * 60 * 60_000 }, async () => {
      grantCalled = true;
      return "saved";
    });
    try {
      const baseUrl = await server.start();
      const { cookie } = await reviewPage(baseUrl);
      const refused = await fetch(`${baseUrl}/operations/${encodedId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html", cookie, origin: baseUrl, referer: `${baseUrl}/operations/${encodedId}` },
        body: new URLSearchParams({ nonce: "not-the-nonce", remember: "1" }),
        redirect: "manual",
      });
      expect(refused.status).toBe(409);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(grantCalled).toBe(false);
    } finally {
      await server.close();
    }
  });
});
