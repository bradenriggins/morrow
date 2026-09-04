import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { isJsonObject, sha256Text, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
import { canvasReadResult } from "./canvas-read.js";
import type { GatewayRuntime } from "./runtime.js";

const inputSchema = z.object({
  source_binding_id: z.string().min(1).max(160),
  course_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  page_url: z.string().min(1).max(1000).describe("The page identifier from Canvas, not a full web address."),
  find_text: z.string().min(1).max(10000).describe("One exact, unique visible phrase within a single text section. Do not include HTML."),
  replace_text: z.string().max(10000).describe("Plain replacement text. Use an empty string to remove the selected phrase."),
});

class PageCorrectionError extends Error {}

function exactId(value: unknown): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new PageCorrectionError("The page identifier is not exact.");
  const id = String(value);
  if (!/^[1-9][0-9]{0,18}$/.test(id)) throw new PageCorrectionError("The page identifier is unavailable.");
  return id;
}

function checkAnchor(body: string, find: string): void {
  const anchor = find.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const start = body.indexOf(anchor);
  if (start < 0 || body.indexOf(anchor, start + 1) !== -1) throw new PageCorrectionError("Choose a phrase that appears exactly once on this page.");
  const end = start + anchor.length;
  for (const entity of body.matchAll(/&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);?/g)) {
    const entityStart = entity.index;
    const entityEnd = entityStart + entity[0].length;
    if ((entityStart < start && start < entityEnd) || (entityStart < end && end < entityEnd)) {
      throw new PageCorrectionError("Choose visible page text, not an HTML character reference.");
    }
  }
  let blocked = false;
  for (const match of body.matchAll(/<!--[\s\S]*?-->|<(?:(?:"[^"]*"|'[^']*'|[^'">])*)>/g)) {
    if (match.index >= end) break;
    if (match.index + match[0].length > start) throw new PageCorrectionError("Choose visible page text, not an image setting or HTML.");
    if (/^<(script|style|iframe|object|embed|textarea|title)\b/i.test(match[0])) blocked = true;
    if (/^<\/(script|style|iframe|object|embed|textarea|title)\s*>/i.test(match[0])) blocked = false;
  }
  if (blocked) throw new PageCorrectionError("Text inside embedded content cannot be changed by this workflow.");
}

export async function planPageCorrection(runtime: GatewayRuntime, value: z.infer<typeof inputSchema>, callerSignal?: AbortSignal): Promise<CallToolResult> {
  const input = inputSchema.parse(value);
  const timeout = AbortSignal.timeout(60_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  try {
    if (input.find_text === input.replace_text) throw new PageCorrectionError("The replacement is the same as the current text.");
    let source: string | undefined;
    const tool = (name: string, readOnly: boolean) => {
      const matches = runtime.searchCatalog({ query: name, limit: 100 }).tools.filter((candidate) => {
        const descriptor = runtime.capabilityGet(candidate.publicName).descriptor;
        return candidate.upstreamName === name && candidate.annotations?.readOnlyHint === readOnly
          && (!source || candidate.upstreamId === source) && isJsonObject(descriptor)
          && isJsonObject(descriptor.route) && descriptor.route.backend === "canvas-connector";
      });
      if (matches.length !== 1) throw new PageCorrectionError("The Canvas connection needed for this page is unavailable.");
      source = matches[0]!.upstreamId;
      return matches[0]!.publicName;
    };
    const writeTool = tool("canvas_update_create_page_courses", false);
    const read = async (name: string, args: JsonObject) => canvasReadResult(runtime, await runtime.callSourceOwned(tool(name, true), {
      ...args, _morrow: { source_binding_id: input.source_binding_id },
    }, { signal }));
    const args = { course_id: input.course_id, url_or_id: input.page_url };
    const [courseResult, pageResult, revisionResult] = await Promise.all([
      read("canvas_get_single_course_courses", { id: input.course_id }),
      read("canvas_show_page_courses", args),
      read("canvas_show_revision_courses_latest", args),
    ]);
    const course = courseResult.data;
    const page = pageResult.data;
    const revision = revisionResult.data;
    if (!isJsonObject(course) || exactId(course.id) !== input.course_id || typeof course.name !== "string"
      || !isJsonObject(page) || !isJsonObject(revision) || typeof page.body !== "string"
      || pageResult.pageBodySha256 !== sha256Text(page.body)) throw new PageCorrectionError("Morrow could not read the complete, unchanged source page. Refresh the Canvas connection before trying again.");
    if (page.editor === "block_editor" || page.block_editor_attributes != null) throw new PageCorrectionError("This workflow cannot safely change a Canvas block-editor page.");
    const fields: JsonObject = {};
    for (const field of ["url", "title", "published", "front_page", "editing_roles"]) {
      const expectedType = ["published", "front_page"].includes(field) ? "boolean" : "string";
      if (typeof page[field] !== expectedType) throw new PageCorrectionError("Canvas did not return all the page settings needed for this check.");
      fields[field] = page[field];
    }
    if (revision.latest !== true || revision.body !== page.body || revision.url !== page.url || revision.title !== page.title) throw new PageCorrectionError("The page changed during this check. Read the current page and create a new review.");
    checkAnchor(page.body, input.find_text);
    signal.throwIfAborted();
    const guard = { page_id: exactId(page.page_id), revision_id: exactId(revision.revision_id), body_sha256: pageResult.pageBodySha256, fields, find_text: input.find_text, replace_text: input.replace_text };
    const planned = runtime.planOperation(writeTool, { course_id: input.course_id, url_or_id: page.url, _morrow: { source_binding_id: input.source_binding_id, page_guard: guard } });
    if (planned.isError === true) return planned as unknown as CallToolResult;
    return {
      ...planned,
      content: [{ type: "text", text: `Review this text change in ${String(page.title)} (${course.name}).\n\nCurrent text: ${input.find_text}\nReplacement: ${input.replace_text || "Remove this text"}\n\nNo change has been sent. The review covers this phrase only. The bridge will keep the other page content and settings, check the page again before sending, and check the saved page and revision history afterward. Canvas does not lock the page during these checks. If another edit is detected, Morrow will stop or report that it could not confirm the result.` }],
    } as CallToolResult;
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: `No change was planned. ${error instanceof PageCorrectionError ? error.message : "Morrow could not finish the page check. Check the Canvas connection and try again."}` }], structuredContent: { schema: "morrow.problem.v1", code: "page_correction_not_planned" } };
  }
}

export function registerPageCorrectionTool(server: McpServer, runtime: GatewayRuntime): void {
  server.registerTool("morrow_plan_page_correction", {
    title: "Review a page text change",
    description: "Plan one exact visible-text replacement on an existing Canvas page. Preserves the other HTML and page settings. Reads and binds the current page and revision, then uses the separate Morrow approval flow. The Chrome bridge checks for stale content before sending and verifies the full page and one new revision afterward. No Canvas write occurs during planning. Does not support block-editor pages or provide an atomic Canvas edit lock.",
    inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (input, context) => planPageCorrection(runtime, input, context.mcpReq.signal));
}
