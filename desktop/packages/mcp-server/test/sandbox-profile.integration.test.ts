import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Json } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { parseGatewayConfig } from "../src/config.js";
import { GatewayRuntime } from "../src/runtime.js";

const sandboxPath = fileURLToPath(new URL("../dist/sandbox-upstream.js", import.meta.url));
const examplePath = fileURLToPath(new URL("../../../morrow.upstreams.sandbox.example.json", import.meta.url));

function sandboxConfig(estatePath = ":memory:") {
  return parseGatewayConfig(JSON.parse(readFileSync(examplePath, "utf8")), {
    MORROW_SANDBOX_MCP_COMMAND: process.execPath,
    MORROW_SANDBOX_MCP_PATH: sandboxPath,
    MORROW_SANDBOX_ESTATE_PATH: estatePath,
    MORROW_SANDBOX_STATE_PATH: ":memory:",
  });
}

function initialEstateText(): string {
  const pages: Record<string, Record<string, unknown>> = {};
  for (let course = 1; course <= 100; course += 1) {
    const courseId = String(90_000 + course);
    pages[`${courseId}\0welcome`] = {
      course_id: courseId,
      page_slug: "welcome",
      title: `Sandbox course ${course}`,
      body: `Deterministic sandbox page ${course}.`,
      revision: 1,
    };
  }
  return `${JSON.stringify({ schema: "morrow.sandbox-estate.v1", pages })}\n`;
}

function writePrivateEstate(path: string, content = initialEstateText()): void {
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function startupFailure(path: string): string {
  const child = spawnSync(process.execPath, [sandboxPath], {
    encoding: "utf8",
    env: { ...process.env, MORROW_SANDBOX_ESTATE_PATH: path },
    input: "",
    timeout: 5_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status).not.toBe(0);
  return child.stderr;
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

  it("refuses a caller-supplied readback on the sandbox route", async () => {
    const runtime = await GatewayRuntime.connect(sandboxConfig(), { journalPath: ":memory:" });
    try {
      const refused = runtime.planOperation("canvas_page_update", {
        course_id: "90003",
        page_slug: "welcome",
        title: "Self-certified",
        body: "Caller chose the comparator.",
        expected_revision: 1,
        _morrow: { readback: { tool: "canvas_courses_list", arguments: { offset: 0, limit: 1 }, expected_digest: "a".repeat(64) } },
      });
      expect(refused.structuredContent).toMatchObject({ phase: "rejected", data: { code: "caller_readback_refused" } });
      expect(runtime.operationList(10)).toMatchObject({ returned: 0 });
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

  it("admits only one bounded exact private estate file with its complete schema", () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-sandbox-estate-boundary-"));
    try {
      const target = join(directory, "target.json");
      writePrivateEstate(target);

      if (process.platform !== "win32") {
        const symbolic = join(directory, "symbolic.json");
        symlinkSync(basename(target), symbolic);
        expect(startupFailure(symbolic)).toContain("sandbox estate is not one exact private file");
      }

      const hardAlias = join(directory, "hard-alias.json");
      linkSync(target, hardAlias);
      expect(startupFailure(hardAlias)).toContain("sandbox estate is not one exact private file");

      if (process.platform !== "win32") {
        const shared = join(directory, "shared.json");
        writePrivateEstate(shared);
        chmodSync(shared, 0o644);
        expect(startupFailure(shared)).toContain("sandbox estate is not one exact private file");
      }

      const oversized = join(directory, "oversized.json");
      writePrivateEstate(oversized, "{}");
      truncateSync(oversized, 16 * 1024 * 1024 + 1);
      expect(startupFailure(oversized)).toContain("sandbox estate is not one exact private file");

      const unsupported = join(directory, "unsupported.json");
      const value = JSON.parse(initialEstateText()) as Record<string, unknown>;
      value.unexpected = true;
      writePrivateEstate(unsupported, `${JSON.stringify(value)}\n`);
      expect(startupFailure(unsupported)).toContain("sandbox estate has an unsupported format");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("durably replaces and reloads the exact private estate", async () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-sandbox-estate-durable-"));
    const estatePath = join(directory, "state", "estate.json");
    let runtime: GatewayRuntime | null = null;
    try {
      runtime = await GatewayRuntime.connect(sandboxConfig(estatePath), { journalPath: ":memory:" });
      const expected = {
        course_id: "90003",
        page_slug: "welcome",
        title: "Durable sandbox page",
        body: "Private synthetic content.",
        revision: 2,
      };
      const planned = runtime.planOperation("canvas_page_update", {
        course_id: expected.course_id,
        page_slug: expected.page_slug,
        title: expected.title,
        body: expected.body,
        expected_revision: 1,
      });
      const id = operationId(planned);
      runtime.approveOperation(id);
      await expect(runtime.dispatchOperation(id)).resolves.toMatchObject({
        structuredContent: { status: "verified", data: expected },
      });
      await runtime.close();
      runtime = null;

      const identity = lstatSync(estatePath);
      expect(identity.isFile()).toBe(true);
      expect(identity.nlink).toBe(1);
      if (process.platform !== "win32") expect(identity.mode & 0o077).toBe(0);
      expect(readdirSync(dirname(estatePath)).filter((name) => name.includes(".tmp-"))).toEqual([]);
      const saved = JSON.parse(readFileSync(estatePath, "utf8")) as { pages: Record<string, unknown> };
      expect(saved.pages[`${expected.course_id}\0${expected.page_slug}`]).toEqual(expected);

      runtime = await GatewayRuntime.connect(sandboxConfig(estatePath), { journalPath: ":memory:" });
      await expect(runtime.call("canvas_page_get", {
        course_id: expected.course_id,
        page_slug: expected.page_slug,
      })).resolves.toMatchObject({ structuredContent: { data: expected } });
    } finally {
      await runtime?.close().catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
