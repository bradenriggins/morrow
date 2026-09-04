import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256Json, type JsonObject } from "@morrow/contracts";
import { parseGatewayConfig } from "../src/config.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";
import { GatewayRuntime } from "../src/runtime.js";

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
      expect(body).toContain("Check that this matches what you asked for");
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
});
