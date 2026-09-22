import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { GatewayRuntime } from "./runtime.js";

export const BLACKBOARD_CONTENT_PATCH_PLAN_TOOL = "blackboard_plan_content_patch";
export const BLACKBOARD_CONTENT_PATCH_APPLY_TOOL = "blackboard_apply_reviewed_content_patch";
export const BLACKBOARD_CONTENT_PATCH_VERIFY_TOOL = "blackboard_verify_content_patch";
export const BLACKBOARD_CONTENT_PATCH_PLAN_NATIVE_TOOL = "morrow_plan_blackboard_content_patch";

const blackboardId = z.string().regex(/^_[1-9][0-9]{0,18}_[1-9][0-9]{0,18}$/);

export const blackboardContentPatchInputSchema = z.strictObject({
  tenant_id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  source_binding_id: z.string().regex(/^[A-Za-z0-9_.:@-]{1,160}$/),
  course_id: blackboardId,
  content_id: blackboardId,
  patch: z.record(z.string(), z.unknown()),
});

export type BlackboardContentPatchInput = z.infer<typeof blackboardContentPatchInputSchema>;

export function registerBlackboardContentPatchTool(server: McpServer, runtime: GatewayRuntime): void {
  server.registerTool(BLACKBOARD_CONTENT_PATCH_PLAN_NATIVE_TOOL, {
    title: "Prepare a Blackboard content update for review",
    description: "Prepare one Blackboard Learn content update through the configured local REST API. Morrow reads the selected integration account, course membership, learner roster, and content item before it freezes the exact patch for human review. It does not send a Blackboard PATCH request while planning. Blackboard API configuration is present, but this integration has not received a live Blackboard validation claim.",
    inputSchema: blackboardContentPatchInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input, context) => {
    return await runtime.planBlackboardContentPatch(input, { signal: context.mcpReq.signal }) as CallToolResult;
  });
}
