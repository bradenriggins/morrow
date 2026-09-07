import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { BLACKBOARD_TOOL_DEFINITIONS } from "@morrow/blackboard-learn-api";
import * as z from "zod/v4";
import type { GatewayRuntime } from "./runtime.js";

export const BLACKBOARD_ATTACHMENT_APPLY_TOOL = "blackboard_apply_reviewed_content_attachment";

export const BLACKBOARD_ACTIONS = BLACKBOARD_TOOL_DEFINITIONS
  .filter((tool) => tool.rest.access === "write" && tool.name !== "blackboard_apply_reviewed_content_patch")
  .map((apply) => {
    const plan = BLACKBOARD_TOOL_DEFINITIONS.find((tool) => tool.name === apply.rest.reviewRoute);
    const verify = BLACKBOARD_TOOL_DEFINITIONS.find((tool) => tool.name === apply.rest.readbackComparator);
    if (!plan || !verify || !(plan.inputSchema instanceof z.ZodObject)) {
      throw new Error(`Blackboard action ${apply.name} has no complete review contract.`);
    }
    const attachment = apply.name === BLACKBOARD_ATTACHMENT_APPLY_TOOL;
    const inputSchema = attachment
      ? plan.inputSchema.omit({ filename: true, size_bytes: true, sha256: true })
        .extend({ file_path: z.string().min(1).max(4096) })
      : plan.inputSchema;
    return { apply, plan, verify, attachment, inputSchema, publicName: plan.name.replace(/^blackboard_plan_/, "morrow_plan_blackboard_") };
  });

export function registerBlackboardActionTools(server: McpServer, runtime: GatewayRuntime, workspaceRoot?: string): void {
  for (const action of BLACKBOARD_ACTIONS) {
    server.registerTool(action.publicName, {
      title: action.plan.title,
      description: `${action.plan.description} Prepare this change for Morrow review. Dispatch requires approval and a fresh readback. ${action.attachment ? "Select a file in the assistant workspace; the file bytes stay out of the conversation and saved plan." : ""}`.trim(),
      inputSchema: action.inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async (input, context) => await runtime.planBlackboardAction(action.publicName, input, {
      signal: context.mcpReq.signal, workspaceRoot,
    }) as CallToolResult);
  }
}
