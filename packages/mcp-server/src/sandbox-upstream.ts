#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

type Page = {
  course_id: string;
  page_slug: string;
  title: string;
  body: string;
  revision: number;
};

type Estate = {
  schema: "morrow.sandbox-estate.v1";
  pages: Record<string, Page>;
};

const estatePathValue = String(process.env.MORROW_SANDBOX_ESTATE_PATH || ":memory:").trim();
const estatePath = estatePathValue === ":memory:" ? estatePathValue : resolve(estatePathValue);

function pageKey(courseId: string, pageSlug: string): string {
  return `${courseId}\0${pageSlug}`;
}

function initialEstate(): Estate {
  const pages: Record<string, Page> = {};
  for (let course = 1; course <= 100; course += 1) {
    const courseId = String(90_000 + course);
    const page: Page = {
      course_id: courseId,
      page_slug: "welcome",
      title: `Sandbox course ${course}`,
      body: `Deterministic sandbox page ${course}.`,
      revision: 1,
    };
    pages[pageKey(courseId, page.page_slug)] = page;
  }
  return { schema: "morrow.sandbox-estate.v1", pages };
}

function loadEstate(): Estate {
  if (estatePath === ":memory:" || !existsSync(estatePath)) return initialEstate();
  const value = JSON.parse(readFileSync(estatePath, "utf8")) as Estate;
  if (value.schema !== "morrow.sandbox-estate.v1" || !value.pages || typeof value.pages !== "object") {
    throw new Error("sandbox estate has an unsupported format");
  }
  return value;
}

let estate = loadEstate();

function persist(): void {
  if (estatePath === ":memory:") return;
  mkdirSync(dirname(estatePath), { recursive: true, mode: 0o700 });
  const temporary = `${estatePath}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(estate)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, estatePath);
}

function notSent(code: string, text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
    structuredContent: { status: "not_sent", code },
  };
}

function selectedPage(courseId: string, pageSlug: string): Page {
  const page = estate.pages[pageKey(courseId, pageSlug)];
  if (!page) throw new Error("sandbox_page_not_found");
  return structuredClone(page);
}

function rateMeta(requestCost = 0.1, rateLimitRemaining = 700) {
  return {
    "io.morrow/canvas-rate": {
      schema: "morrow.canvas-rate.v1",
      requestCost,
      rateLimitRemaining,
    },
  };
}

const CourseId = z.string().regex(/^90[0-9]{3}$/);
const PageSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);

function createSandboxServer(): McpServer {
  const server = new McpServer({ name: "morrow-sandbox", version: "1.0.0-rc.0" });

  server.registerTool(
    "canvas_courses_list",
    {
      description: "List a bounded page from the deterministic 100-course sandbox estate.",
      inputSchema: z.object({
        offset: z.number().int().min(0).max(99).default(0),
        limit: z.number().int().min(1).max(100).default(25),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ offset, limit }) => {
      const courses = Array.from({ length: 100 }, (_, index) => ({
        course_id: String(90_001 + index),
        title: `Sandbox course ${index + 1}`,
      })).slice(offset, offset + limit);
      return {
        content: [{ type: "text", text: `Returned ${courses.length} synthetic courses.` }],
        _meta: rateMeta(),
        structuredContent: {
          courses,
          offset,
          returned: courses.length,
          total: 100,
          next_offset: offset + courses.length < 100 ? offset + courses.length : null,
          pagination_complete: offset + courses.length >= 100,
        },
      };
    },
  );

  server.registerTool(
    "canvas_page_get",
    {
      description: "Read one page from the deterministic sandbox estate.",
      inputSchema: z.object({ course_id: CourseId, page_slug: PageSlug.default("welcome") }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ course_id, page_slug }) => {
      const page = selectedPage(course_id, page_slug);
      return {
        content: [{ type: "text", text: `Read ${course_id}/${page_slug} from the synthetic estate.` }],
        _meta: rateMeta(),
        structuredContent: page,
      };
    },
  );

  server.registerTool(
    "canvas_page_update",
    {
      description: "Update one synthetic page. Optional faults model definite rejection or ambiguous delivery.",
      inputSchema: z.object({
        course_id: CourseId,
        page_slug: PageSlug.default("welcome"),
        title: z.string().min(1).max(200),
        body: z.string().max(20_000),
        expected_revision: z.number().int().min(1),
        fault: z.enum(["none", "reject_before_apply", "throw_after_apply"]).default("none"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ course_id, page_slug, title, body, expected_revision, fault }) => {
      const current = estate.pages[pageKey(course_id, page_slug)];
      if (!current) return notSent("sandbox_page_not_found", "The synthetic page does not exist.");
      if (current.revision !== expected_revision) {
        return notSent("sandbox_revision_conflict", "The synthetic page revision changed.");
      }
      if (fault === "reject_before_apply") {
        return notSent("sandbox_rejected_before_apply", "The synthetic provider rejected the request before apply.");
      }
      const updated: Page = { course_id, page_slug, title, body, revision: current.revision + 1 };
      estate = {
        ...estate,
        pages: { ...estate.pages, [pageKey(course_id, page_slug)]: updated },
      };
      persist();
      if (fault === "throw_after_apply") throw new Error("sandbox_ambiguous_after_apply");
      return {
        content: [{ type: "text", text: `Updated ${course_id}/${page_slug} in the synthetic estate.` }],
        _meta: rateMeta(0.2, 699.8),
        structuredContent: updated,
      };
    },
  );

  return server;
}

await serveStdio(createSandboxServer);
