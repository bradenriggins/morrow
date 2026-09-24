import { type CallToolResult, type McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { confirmedEditAccess, EditAccessReviewUnavailableError } from "./edit-access-review.js";
import { EditCategoryUnavailableError } from "./runtime.js";
import type {
  BrowserEditAccessPrepared,
  BrowserEditAccessResult,
  BrowserEditAccessSelectionInput,
  GatewayRuntime,
} from "./runtime.js";

const sourceBindingId = z.string().regex(/^[A-Za-z0-9_.:@-]{1,160}$/);
const inputSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("edit"),
    selections: z.array(z.strictObject({
      source_binding_id: sourceBindingId,
      enabled_categories: z.array(z.string().regex(/^[A-Za-z0-9_.:@-]{1,160}$/)).min(1).max(500),
    })).min(1).max(500),
  }),
  z.strictObject({
    mode: z.literal("plan"),
    selections: z.array(z.strictObject({ source_binding_id: sourceBindingId })).min(1).max(500),
  }),
]);

type Input = z.infer<typeof inputSchema>;

function problem(code: string, message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    structuredContent: { schema: "morrow.edit-access.v1", ok: false, code },
  };
}

function selections(input: Input): readonly BrowserEditAccessSelectionInput[] {
  return input.selections.map((selection) => ({
    sourceBindingId: selection.source_binding_id,
    ...("enabled_categories" in selection ? { enabledCategories: [...selection.enabled_categories].sort() } : {}),
  }));
}

function resultFor(prepared: BrowserEditAccessPrepared, result: BrowserEditAccessResult): CallToolResult {
  const { allConfirmed, selections: actual } = confirmedEditAccess(prepared, result);
  return {
    content: [{ type: "text", text: allConfirmed
      ? `Morrow confirmed ${prepared.mode === "edit" ? "Edit" : "Plan"} access for every selected course connection.`
      : "Morrow could not confirm every selected course connection. Review each current state before any change." }],
    ...(allConfirmed ? {} : { isError: true }),
    structuredContent: {
      schema: "morrow.edit-access.v1",
      ok: allConfirmed,
      mode: prepared.mode,
      outcome: result.outcome,
      selections: actual,
      ...(result.command ? { command: result.command } : {}),
    },
  };
}

export function registerEditAccessTool(server: McpServer, runtime: GatewayRuntime): void {
  server.registerTool("morrow_request_edit_access", {
    title: "Set selected course access",
    description: "Ask the person to turn on Edit for exact current course connections and selected kinds of change. Morrow opens a review page and returns its link; Edit turns on only when the person selects Turn on Edit there in Chrome with Morrow Bridge connected. The kinds join the Edit each course already has. Give them the link, then call morrow_operation_wait with edit_access_id. Actions that remove content are turned on only in Morrow Bridge Plan and Edit settings. Set Plan to return selected courses to Plan at once, with a fresh current readback.",
    inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input): Promise<CallToolResult> => {
    let prepared: BrowserEditAccessPrepared;
    try {
      prepared = await runtime.prepareBrowserEditAccess(input.mode, selections(input));
    } catch (error) {
      if (error instanceof EditCategoryUnavailableError) {
        return {
          content: [{ type: "text", text: `Morrow cannot grant Edit access for ${error.categoryId}. ${error.reason}` }],
          isError: true,
          structuredContent: {
            schema: "morrow.edit-access.v1",
            ok: false,
            code: "edit_access_category_unavailable",
            category: error.categoryId,
            reason: error.reason,
          },
        };
      }
      return problem("edit_access_preflight_refused", "Morrow could not verify every selected current course connection.");
    }
    if (input.mode === "plan") {
      try {
        return resultFor(prepared, await runtime.applyBrowserEditAccess(prepared));
      } catch {
        return problem("edit_access_plan_refused", "Morrow could not set Plan access because the selected current course connection changed.");
      }
    }
    try {
      const review = runtime.createEditAccessReview(prepared);
      return {
        content: [{
          type: "text",
          text: `Morrow opened an Edit access review. Give the person this link: ${String(review.approvalUrl)} Edit turns on only when they select Turn on Edit there in Chrome with Morrow Bridge connected. Then call morrow_operation_wait with edit_access_id ${String(review.editAccessId)}.`,
        }],
        structuredContent: review,
      };
    } catch (error) {
      if (error instanceof EditAccessReviewUnavailableError) {
        return problem("edit_access_review_unavailable", "Morrow cannot show its Edit access review on this computer, so Morrow kept access unchanged.");
      }
      return problem("edit_access_review_refused", "Morrow could not open an Edit access review. Morrow kept access unchanged.");
    }
  });
}
