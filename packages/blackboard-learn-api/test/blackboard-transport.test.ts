import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveBlackboardSourceBindingId } from "../src/binding.js";
import { BlackboardLearnClient } from "../src/client.js";
import { loadBlackboardLearnConfig } from "../src/config.js";
import { BlackboardApiError, type BlackboardTenant } from "../src/types.js";

const baseUrl = "https://learn.example.edu";
const courseId = "_22_1";
const contentId = "_33_1";
const principalId = "_11_1";
const tokenPath = "/learn/api/public/v1/oauth2/token";
const contentsPath = `/learn/api/public/v1/courses/${courseId}/contents`;
const contentPath = `${contentsPath}/${contentId}`;

const tenant: BlackboardTenant = {
  id: "fixture",
  baseUrl,
  applicationKey: "app-key",
  clientSecret: "client-secret",
  principalId,
  courseBindings: [{ sourceBindingId: deriveBlackboardSourceBindingId(baseUrl, principalId, courseId), courseId }],
};

/** One Learn answer, written the way a tenant sends it. */
interface Answer {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

interface Sent {
  readonly method: string;
  readonly url: URL;
  readonly body?: string;
}

/**
 * A client over a stubbed transport. The credential exchange is answered here so
 * each test states only what the Learn route it exercises returned, and every
 * request that left the client is recorded.
 */
function transport(answer: (request: Sent) => Answer, options?: { readonly diagnosticHeaders?: readonly string[] }) {
  const sent: Sent[] = [];
  let tokens = 0;
  const fetcher = (async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = String(init.method || "GET");
    if (url.pathname === tokenPath) {
      tokens += 1;
      return new Response(JSON.stringify({ access_token: "temporary-token", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const request: Sent = { method, url, ...(typeof init.body === "string" ? { body: init.body } : {}) };
    sent.push(request);
    const next = answer(request);
    const status = next.status ?? 200;
    const body = next.body === undefined || status === 204 ? null : JSON.stringify(next.body);
    return new Response(body, {
      status,
      headers: { ...(next.headers || {}), ...(body === null ? {} : { "content-type": "application/json" }) },
    });
  }) as typeof fetch;
  return {
    sent,
    tokens: () => tokens,
    client: new BlackboardLearnClient(tenant, fetcher, options ? { ...options } : {}),
  };
}

function records(count: number, offset = 0): { readonly results: readonly { readonly id: string }[] } {
  return { results: Array.from({ length: count }, (unused, index) => ({ id: `_${offset + index + 1}_1` })) };
}

describe("Blackboard transport", () => {
  it("reads a created record and treats an accepted change with no body as no record", async () => {
    const { client, sent } = transport(({ method }) => {
      if (method === "POST") return { status: 201, body: { id: "_44_1", title: "Week 1 announcement" } };
      return { status: 204 };
    });
    await expect(client.post(`/learn/api/public/v1/courses/${courseId}/announcements`, { title: "Week 1 announcement" }))
      .resolves.toEqual({ id: "_44_1", title: "Week 1 announcement" });
    await expect(client.patch(contentPath, { title: "Reviewed title" })).resolves.toBeNull();
    await expect(client.put(`/learn/api/public/v1/courses/${courseId}/groups/_55_1/users/_44_1`, {})).resolves.toBeNull();
    await expect(client.del(`/learn/api/public/v1/courses/${courseId}/groups/_55_1/users/_44_1`)).resolves.toBeNull();
    expect(sent.map((request) => request.method)).toEqual(["POST", "PATCH", "PUT", "DELETE"]);
    expect(sent[0]?.body).toBe(JSON.stringify({ title: "Week 1 announcement" }));
  });

  it("refuses a read that Blackboard answered without a record", async () => {
    const { client } = transport(() => ({ status: 204 }));
    await expect(client.get(contentPath)).rejects.toMatchObject({
      code: "blackboard_response_invalid",
      message: "Blackboard answered this read without a record.",
    });
  });

  it("keeps Retry-After and the tenant's rate-limit headers on the failure and sends nothing again", async () => {
    const { client, sent, tokens } = transport(() => ({
      status: 429,
      body: { message: "too many requests" },
      headers: { "retry-after": "30", "x-rate-limit-remaining": "0", "x-rate-limit-reset": "1757203200" },
    }));
    const failure = await client.patch(contentPath, { title: "Reviewed title" }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(BlackboardApiError);
    expect(failure).toMatchObject({
      code: "blackboard_request_rate_limited",
      status: 429,
      dispatchState: "not_sent",
      message: "Blackboard rate-limited this request. The request was not retried.",
      diagnostics: { "retry-after": "30", "x-rate-limit-remaining": "0", "x-rate-limit-reset": "1757203200" },
    });
    // One credential exchange and one request: a rate-limit header is a
    // diagnostic, never a reason to send the request again.
    expect(sent).toHaveLength(1);
    expect(tokens()).toBe(1);
  });

  it("records the rate-limit header names a tenant is configured to send", async () => {
    const { client } = transport(() => ({
      status: 429,
      headers: { "retry-after": "5", "x-rate-limit-remaining": "0", "x-blackboard-quota-remaining": "12" },
    }), { diagnosticHeaders: ["Retry-After", "x-blackboard-quota-remaining"] });
    const failure = await client.get(contentPath).then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({
      code: "blackboard_request_rate_limited",
      diagnostics: { "retry-after": "5", "x-blackboard-quota-remaining": "12" },
    });
    expect((failure as BlackboardApiError).diagnostics?.["x-rate-limit-remaining"]).toBeUndefined();
  });

  it("repeats a read once after a rejected credential and never repeats a write", async () => {
    let reads = 0;
    const { client, sent, tokens } = transport(({ method }) => {
      if (method !== "GET") return { status: 401, body: { message: "expired" } };
      reads += 1;
      return reads === 1 ? { status: 401, body: { message: "expired" } } : { status: 200, body: { id: contentId } };
    });
    await expect(client.get(contentPath)).resolves.toMatchObject({ id: contentId });
    expect(tokens()).toBe(2);
    for (const write of [
      () => client.post(contentsPath, { title: "New item" }),
      () => client.put(contentPath, { title: "New item" }),
      () => client.patch(contentPath, { title: "New item" }),
      () => client.del(contentPath),
    ]) {
      await expect(write()).rejects.toMatchObject({ code: "blackboard_request_unauthorized", status: 401, dispatchState: "not_sent" });
    }
    expect(sent.filter((request) => request.method !== "GET").map((request) => request.method))
      .toEqual(["POST", "PUT", "PATCH", "DELETE"]);
  });

  it("refuses every write outside this tenant's origin before a credential is used", async () => {
    const { client, sent, tokens } = transport(() => ({ status: 200, body: {} }));
    const outside = "https://elsewhere.example/learn/api/public/v1/courses/_22_1/contents";
    for (const write of [
      () => client.post(outside, {}),
      () => client.put(outside, {}),
      () => client.patch(outside, {}),
      () => client.del(outside),
      () => client.get(outside),
    ]) {
      await expect(write()).rejects.toMatchObject({ code: "blackboard_scope_binding_mismatch", dispatchState: "not_sent" });
    }
    expect(sent).toHaveLength(0);
    expect(tokens()).toBe(0);
  });

  it("names a collection query in typed fields instead of a concatenated query string", async () => {
    const { client, sent } = transport(() => ({ body: { results: [] } }));
    await expect(client.collect(`/learn/api/public/v1/users/${principalId}/courses`, {
      limit: 50,
      fields: ["id", "courseId", "name"],
      expand: ["course"],
    })).resolves.toEqual([]);
    expect(sent[0]?.url.searchParams.get("limit")).toBe("50");
    expect(sent[0]?.url.searchParams.get("fields")).toBe("id,courseId,name");
    expect(sent[0]?.url.searchParams.get("expand")).toBe("course");
    // The roster read keeps the exact query it had before the helper existed.
    await client.listCourseMemberships(courseId);
    expect(sent[1]?.url.search).toBe("?limit=100&expand=user");
  });

  it("accepts exactly five thousand records and refuses one more", async () => {
    const accepted = transport(() => ({ body: records(5_000) }));
    await expect(accepted.client.listContents(courseId)).resolves.toHaveLength(5_000);

    const refused = transport(() => ({ body: records(5_001) }));
    await expect(refused.client.listContents(courseId)).rejects.toMatchObject({
      code: "blackboard_response_incomplete",
      message: "Blackboard returned too many content records.",
    });

    const paged = transport(({ url }) => url.searchParams.get("offset") === "2500"
      ? { body: records(2_501, 2_500) }
      : { body: { ...records(2_500), paging: { nextPage: `${contentsPath}?limit=100&offset=2500` } } });
    await expect(paged.client.listContents(courseId)).rejects.toMatchObject({
      code: "blackboard_response_incomplete",
      message: "Blackboard returned too many content records.",
    });
  });

  it("refuses a next page outside this course endpoint", async () => {
    const offOrigin = transport(() => ({
      body: { ...records(1), paging: { nextPage: `https://outside.example${contentsPath}?limit=100&offset=100` } },
    }));
    await expect(offOrigin.client.listContents(courseId)).rejects.toMatchObject({ code: "blackboard_pagination_refused" });

    const otherPath = transport(() => ({
      body: { ...records(1), paging: { nextPage: `/learn/api/public/v1/courses/${courseId}/users?limit=100&offset=100` } },
    }));
    await expect(otherPath.client.listContents(courseId)).rejects.toMatchObject({ code: "blackboard_pagination_refused" });
  });

  it("refuses a next page it has already read", async () => {
    let page = 0;
    // The next page is the page that was just read, whatever query the listing
    // pinned on it, which is exactly the cycle this refusal exists to catch.
    const { client, sent } = transport(({ url }) => {
      page += 1;
      return { body: { results: [{ id: `_${page}_1` }], paging: { nextPage: `${url.pathname}${url.search}` } } };
    });
    await expect(client.listContents(courseId)).rejects.toMatchObject({
      code: "blackboard_pagination_refused",
      message: "Blackboard returned a cyclic content page.",
    });
    expect(sent).toHaveLength(1);
  });

  it("refuses a repeated record identity instead of returning it twice", async () => {
    const { client } = transport(() => ({
      body: {
        results: [
          { id: "_membership_1", userId: "_44_1" },
          { id: "_membership_1", userId: "_45_1" },
        ],
      },
    }));
    await expect(client.listCourseMemberships(courseId)).rejects.toMatchObject({
      code: "blackboard_response_incomplete",
      message: "Blackboard returned duplicate or invalid roster identities.",
    });
  });

  it("refuses more pages than the ceiling allows instead of returning part of a collection", async () => {
    let page = 0;
    const { client, sent } = transport(() => {
      page += 1;
      return {
        body: {
          results: [{ id: `_${page}_1` }],
          paging: { nextPage: `${contentsPath}?limit=100&offset=${page * 100}` },
        },
      };
    });
    await expect(client.listContents(courseId)).rejects.toMatchObject({
      code: "blackboard_response_incomplete",
      message: "Blackboard content pagination exceeded the safe limit.",
    });
    expect(sent).toHaveLength(20);
  });
});

const configured: string[] = [];
const originalHome = process.env.HOME;
afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await Promise.all(configured.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const configDocument = JSON.stringify({
  schema: "morrow.blackboard-learn.config.v1",
  tenants: [{
    id: "school",
    baseUrl,
    applicationKey: "application-key",
    credentialRef: "environment",
    principalId,
    courseBindings: [{ courseId }],
  }],
});
const configEnvironment = { MORROW_BLACKBOARD_SECRET_SCHOOL: "server-secret" };

describe("Blackboard configuration path", () => {
  it("refuses a configured path inside the home directory that a linked ancestor reaches", async () => {
    const home = await mkdtemp(join(tmpdir(), "morrow-blackboard-home-"));
    configured.push(home);
    process.env.HOME = home;
    const nested = join(home, "setup", "morrow");
    await mkdir(nested, { recursive: true, mode: 0o700 });
    await symlink(join(home, "setup"), join(home, "linked"));
    const path = join(nested, "blackboard-learn.json");
    await writeFile(path, configDocument, { mode: 0o600 });

    await expect(loadBlackboardLearnConfig({
      ...configEnvironment,
      MORROW_BLACKBOARD_CONFIG: join(home, "linked", "morrow", "blackboard-learn.json"),
    })).rejects.toThrow("configuration access is not private");
    // The same file, named without the link, is the configuration Morrow reads.
    await expect(loadBlackboardLearnConfig({ ...configEnvironment, MORROW_BLACKBOARD_CONFIG: path }))
      .resolves.toHaveLength(1);
  });

  it("refuses a configured path outside the home directory that another account can write into", async () => {
    const root = await mkdtemp(join(tmpdir(), "morrow-blackboard-outside-"));
    configured.push(root);
    const shared = join(root, "shared");
    const nested = join(shared, "morrow");
    await mkdir(nested, { recursive: true, mode: 0o700 });
    await chmod(shared, 0o777);
    const path = join(nested, "blackboard-learn.json");
    await writeFile(path, configDocument, { mode: 0o600 });
    const environment = { ...configEnvironment, MORROW_BLACKBOARD_CONFIG: path };

    await expect(loadBlackboardLearnConfig(environment)).rejects.toThrow("configuration access is not private");
    await chmod(shared, 0o700);
    await expect(loadBlackboardLearnConfig(environment)).resolves.toHaveLength(1);
  });
});
