import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sha256Json } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { parseGatewayConfig } from "../src/config.js";
import { GatewayRuntime } from "../src/runtime.js";

const sandboxPath = fileURLToPath(new URL("../dist/sandbox-upstream.js", import.meta.url));
const examplePath = fileURLToPath(new URL("../../../morrow.upstreams.sandbox.example.json", import.meta.url));

function sandboxConfig() {
  return parseGatewayConfig(JSON.parse(readFileSync(examplePath, "utf8")), {
    MORROW_SANDBOX_MCP_COMMAND: process.execPath,
    MORROW_SANDBOX_MCP_PATH: sandboxPath,
    MORROW_SANDBOX_ESTATE_PATH: ":memory:",
    MORROW_SANDBOX_STATE_PATH: ":memory:",
  });
}

function operationId(result: Record<string, unknown>): string {
  const structured = result.structuredContent as Record<string, unknown>;
  return String(structured.operationId);
}

describe("sandbox runtime profile", () => {
  it("provides a deterministic estate and verifies one approved write by fresh readback", async () => {
    const runtime = await GatewayRuntime.connect(sandboxConfig(), { journalPath: ":memory:" });
    try {
      expect(runtime.catalog.tools.map((tool) => tool.publicName)).toEqual([
        "canvas_courses_list",
        "canvas_page_get",
        "canvas_page_update",
      ]);
      expect(runtime.profileStatus()).toMatchObject({
        profile: "sandbox",
        supportedToolCount: 3,
        unavailableToolCount: 0,
      });

      const courses = await runtime.call("canvas_courses_list", { offset: 0, limit: 100 });
      expect(courses.structuredContent).toMatchObject({
        data: { returned: 100, total: 100, pagination_complete: true },
      });
      expect(courses._meta).toMatchObject({
        "io.morrow/canvas-rate": { requestCost: 0.1, rateLimitRemaining: 700 },
      });

      const expected = {
        course_id: "90001",
        page_slug: "welcome",
        title: "Updated sandbox page",
        body: "Verified synthetic content.",
        revision: 2,
      };
      const planned = runtime.planOperation("canvas_page_update", {
        course_id: "90001",
        page_slug: "welcome",
        title: expected.title,
        body: expected.body,
        expected_revision: 1,
        fault: "none",
        _morrow: {
          readback: {
            tool: "canvas_page_get",
            arguments: { course_id: "90001", page_slug: "welcome" },
            expected_digest: sha256Json(expected),
          },
        },
      });
      const id = operationId(planned);
      expect(id).toMatch(/^op:/);
      expect(runtime.approveOperation(id)).toMatchObject({ state: "approved" });
      const dispatched = await runtime.dispatchOperation(id);
      expect(dispatched).toMatchObject({
        structuredContent: {
          status: "verified",
          effectState: "verified",
          verification: { status: "verified" },
          data: expected,
        },
      });
    } finally {
      await runtime.close();
    }
  }, 30_000);

  it("distinguishes a definite pre-apply rejection from an ambiguous post-apply failure", async () => {
    const runtime = await GatewayRuntime.connect(sandboxConfig(), { journalPath: ":memory:" });
    try {
      const plan = (fault: "reject_before_apply" | "throw_after_apply", revision: number) => runtime.planOperation(
        "canvas_page_update",
        {
          course_id: "90002",
          page_slug: "welcome",
          title: `Fault ${fault}`,
          body: "Synthetic fault.",
          expected_revision: revision,
          fault,
          _morrow: {
            readback: {
              tool: "canvas_page_get",
              arguments: { course_id: "90002", page_slug: "welcome" },
              expected_digest: "f".repeat(64),
            },
          },
        },
      );

      const rejectedId = operationId(plan("reject_before_apply", 1));
      runtime.approveOperation(rejectedId);
      await runtime.dispatchOperation(rejectedId);
      expect(runtime.operationGet(rejectedId)).toMatchObject({
        state: "failed",
        attention: expect.arrayContaining(["dispatch_failed_before_send"]),
      });

      const ambiguousId = operationId(plan("throw_after_apply", 1));
      runtime.approveOperation(ambiguousId);
      await runtime.dispatchOperation(ambiguousId);
      expect(runtime.operationGet(ambiguousId)).toMatchObject({ state: "applied_or_unknown" });
    } finally {
      await runtime.close();
    }
  }, 30_000);
});
