#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  canonicalPrivateStateFilePath,
  readExactPrivateStateFile,
  replaceExactPrivateStateFile,
} from "@morrow/gateway-core";
import * as z from "zod/v4";

const MAX_ESTATE_FILE_BYTES = 16 * 1024 * 1024;
const ESTATE_FILE_OPTIONS = {
  label: "sandbox estate",
  minBytes: 1,
  maxBytes: MAX_ESTATE_FILE_BYTES,
} as const;

const PageSchema = z.strictObject({
  course_id: z.string().regex(/^90[0-9]{3}$/),
  page_slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  title: z.string().min(1).max(200),
  body: z.string().max(20_000),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});

const EstateSchema = z.strictObject({
  schema: z.literal("morrow.sandbox-estate.v1"),
  pages: z.record(z.string(), PageSchema),
}).superRefine((value, context) => {
  const keys = Object.keys(value.pages);
  if (keys.length !== 100) {
    context.addIssue({ code: "custom", path: ["pages"], message: "expected the deterministic 100-page estate" });
    return;
  }
  for (let course = 1; course <= 100; course += 1) {
    const courseId = String(90_000 + course);
    const key = pageKey(courseId, "welcome");
    const page = value.pages[key];
    if (!page || page.course_id !== courseId || page.page_slug !== "welcome") {
      context.addIssue({ code: "custom", path: ["pages", key], message: "page identity does not match its estate key" });
    }
  }
});

type Page = z.infer<typeof PageSchema>;
type Estate = z.infer<typeof EstateSchema>;

const estatePathValue = String(process.env.MORROW_SANDBOX_ESTATE_PATH || ":memory:").trim();
const estatePath = estatePathValue === ":memory:"
  ? estatePathValue
  : canonicalPrivateStateFilePath(estatePathValue, ESTATE_FILE_OPTIONS.label);

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
  if (estatePath === ":memory:") return initialEstate();
  const content = readExactPrivateStateFile(estatePath, ESTATE_FILE_OPTIONS);
  if (!content) return initialEstate();
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    const parsed = EstateSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch { /* report one stable format error below */ }
  throw new Error("sandbox estate has an unsupported format");
}

let estate = loadEstate();

function persist(nextEstate: Estate): void {
  if (estatePath === ":memory:") return;
  replaceExactPrivateStateFile(
    estatePath,
    Buffer.from(`${JSON.stringify(nextEstate)}\n`, "utf8"),
    ESTATE_FILE_OPTIONS,
  );
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
  const server = new McpServer({ name: "morrow-sandbox", version: "1.0.0" });

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
      const nextEstate: Estate = {
        ...estate,
        pages: { ...estate.pages, [pageKey(course_id, page_slug)]: updated },
      };
      persist(nextEstate);
      estate = nextEstate;
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
