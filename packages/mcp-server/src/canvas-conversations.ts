import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { GatewayRuntime } from "./runtime.js";

export const CANVAS_CONVERSATION_PLAN_SCHEMA = "morrow.canvas-conversation.plan.v1";
export const CANVAS_CONVERSATION_TRANSFER_TOOL = "canvas_send_private_conversation";
export const CANVAS_CONVERSATION_TRANSFER_OPERATION = "canvas.private.conversation.send.v1";

const courseId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const learnerToken = z.string().regex(/^Student A[1-9][0-9]*$/);
const recipientContext = z.string().regex(/^(course|section|group)_[1-9][0-9]{0,18}(?:_(students|teachers|tas|observers|designers))?$/);
const recipients = z.array(learnerToken).max(5_000).optional();
const recipientContexts = z.array(recipientContext).max(5_000).optional();
const common = {
  source_binding_id: z.string().regex(/^[A-Za-z0-9_.:@-]{1,160}$/),
  course_id: courseId,
  recipient_tokens: recipients,
  recipient_contexts: recipientContexts,
  body: z.string().min(1).max(2 * 1024 * 1024),
};

const createInputSchema = z.strictObject({
  action: z.literal("create"),
  ...common,
  subject: z.string().max(255).optional(),
  group_conversation: z.boolean().optional(),
  force_new: z.boolean().optional(),
}).superRefine((value, context) => {
  const tokens = value.recipient_tokens || [];
  const contexts = value.recipient_contexts || [];
  if (tokens.length + contexts.length === 0) {
    context.addIssue({ code: "custom", message: "A new Canvas Inbox conversation needs at least one learner label or current-course recipient context." });
  }
  if (new Set(tokens).size !== tokens.length || new Set(contexts).size !== contexts.length) {
    context.addIssue({ code: "custom", message: "Conversation recipients must be unique." });
  }
});

const replyInputSchema = z.strictObject({
  action: z.literal("reply"),
  ...common,
  conversation_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
}).superRefine((value, context) => {
  const tokens = value.recipient_tokens || [];
  const contexts = value.recipient_contexts || [];
  if (new Set(tokens).size !== tokens.length || new Set(contexts).size !== contexts.length) {
    context.addIssue({ code: "custom", message: "Conversation recipients must be unique." });
  }
});

export const canvasConversationInputSchema = z.discriminatedUnion("action", [createInputSchema, replyInputSchema]);
export type CanvasConversationInput = z.infer<typeof canvasConversationInputSchema>;

export function isCanvasConversationTransfer(mapping: {
  readonly upstreamName: string;
  readonly annotations?: { readonly readOnlyHint?: boolean };
  readonly capability?: {
    readonly provider?: string;
    readonly route?: { readonly backend?: string };
    readonly sourceImplementations?: readonly { readonly toolName: string; readonly sourceExport: string }[];
  };
}): boolean {
  return mapping.upstreamName === CANVAS_CONVERSATION_TRANSFER_TOOL
    && mapping.annotations?.readOnlyHint === false
    && mapping.capability?.provider === "canvas"
    && mapping.capability.route?.backend === "canvas-connector"
    && mapping.capability.sourceImplementations?.some((source) => (
      source.toolName === CANVAS_CONVERSATION_TRANSFER_TOOL
      && source.sourceExport === CANVAS_CONVERSATION_TRANSFER_OPERATION
    )) === true;
}

export function canvasConversationPlan(input: CanvasConversationInput) {
  return {
    schema: CANVAS_CONVERSATION_PLAN_SCHEMA,
    action: input.action,
    recipient_tokens: Object.freeze([...(input.recipient_tokens || [])]),
    recipient_contexts: Object.freeze([...(input.recipient_contexts || [])]),
    body: input.body,
    ...(input.action === "create"
      ? {
          ...(input.subject === undefined ? {} : { subject: input.subject }),
          ...(input.group_conversation === undefined ? {} : { group_conversation: input.group_conversation }),
          ...(input.force_new === undefined ? {} : { force_new: input.force_new }),
        }
      : { conversation_id: input.conversation_id }),
  };
}

export function registerCanvasConversationTool(server: McpServer, runtime: GatewayRuntime): void {
  server.registerTool("morrow_plan_canvas_conversation", {
    title: "Prepare a Canvas Inbox message for review",
    description: "Prepare one Canvas Inbox conversation or reply in one selected course. Use current readable learner labels (for example, Student A1) from that course or one Canvas course, section, or group recipient context. Morrow resolves recipients only at dispatch under a fresh course binding. It freezes the message, action, course, current session, and recipient references for review. No Canvas message is sent while planning.",
    inputSchema: canvasConversationInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (value, context) => {
    const input = canvasConversationInputSchema.parse(value);
    const result = await runtime.planCanvasConversation(input, { signal: context.mcpReq.signal });
    const rendered: CallToolResult = {
      ...result,
      content: [{
        type: "text",
        text: input.action === "create"
          ? "Morrow prepared a Canvas Inbox message for review. No Canvas message has been sent. Before dispatch, Morrow will refresh the selected course connection and recipient roster, resolve only the approved learner labels, send once, and read the resulting conversation back."
          : "Morrow prepared a Canvas Inbox reply for review. No Canvas message has been sent. Before dispatch, Morrow will refresh the selected course connection and recipient roster, read the target conversation, send once, and read the resulting conversation back.",
      }],
    };
    return await runtime.redactMcpEgress(rendered as unknown as Record<string, unknown>, {
      course_id: input.course_id,
      _morrow: { source_binding_id: input.source_binding_id },
    }, {
      signal: context.mcpReq.signal,
      toolName: "morrow_plan_canvas_conversation",
    }) as unknown as CallToolResult;
  });
}
