import { randomUUID } from "node:crypto";
import {
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type CreateMessageRequestParams,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
import type { GatewayRuntime } from "./runtime.js";

const inputSchema = z.strictObject({});
const sampleSchema = z.object({
  model: z.string().min(1).max(200),
  role: z.literal("assistant"),
  content: z.strictObject({ type: z.literal("text"), text: z.string().min(1).max(100_000) }),
  stopReason: z.string().min(1).max(100).optional(),
});

type ChatMessage = { readonly role: "user" | "assistant"; readonly text: string };
export type PrivateChatRequestState = {
  readonly workflow: "morrow.private-chat.v1";
  readonly sessionId: string;
  readonly assistantName: string;
  readonly sourceBindingId: string;
  readonly courseId: string;
  readonly messages: readonly ChatMessage[];
  readonly turns: number;
};

class PrivateChatError extends Error {}
function requireChat(value: unknown, message: string): asserts value {
  if (!value) throw new PrivateChatError(message);
}

function samplingRequest(state: PrivateChatRequestState): CreateMessageRequestParams {
  requireChat(JSON.stringify(state.messages).length <= 400_000, "Private Chat reached its protected transcript limit. Close the drawer and start a new session.");
  return {
    maxTokens: 4_000,
    includeContext: "none",
    systemPrompt: "You are the connected course assistant in Morrow Private Chat. Student A labels are stable pseudonyms for this one course and session. Never infer, request, or reveal the original identity behind a label. Answer the educator's request using only the protected conversation. Do not claim that Morrow changed the learning platform unless a separate verified tool result proves it.",
    messages: state.messages.map((message) => ({
      role: message.role,
      content: { type: "text" as const, text: message.text },
    })),
  };
}

function sampleFromInput(context: ServerContext) {
  const response = inputResponse(context.mcpReq.inputResponses, "private_chat_reply");
  requireChat(response.kind === "sampling", "The assistant response is missing or was declined.");
  return sampleSchema.parse(response.result);
}

function resultClosed(state: Pick<PrivateChatRequestState, "sessionId" | "turns"> & Partial<Pick<PrivateChatRequestState, "sourceBindingId" | "courseId">>): CallToolResult {
  return {
    content: [{ type: "text", text: "Morrow Private Chat closed. The local conversation was cleared." }],
    structuredContent: {
      schema: "morrow.private-chat.v1",
      status: "closed",
      sessionId: state.sessionId,
      ...(state.sourceBindingId ? { sourceBindingId: state.sourceBindingId } : {}),
      ...(state.courseId ? { courseId: state.courseId } : {}),
      turns: state.turns,
    },
  };
}

function stateFromMessage(exchange: JsonObject, assistantName: string): PrivateChatRequestState {
  requireChat(exchange.status === "message"
    && typeof exchange.sessionId === "string"
    && typeof exchange.sourceBindingId === "string"
    && typeof exchange.courseId === "string"
    && typeof exchange.protectedText === "string", "The local protected message is invalid.");
  return {
    workflow: "morrow.private-chat.v1",
    sessionId: exchange.sessionId,
    assistantName,
    sourceBindingId: exchange.sourceBindingId,
    courseId: exchange.courseId,
    messages: [{ role: "user", text: exchange.protectedText }],
    turns: 0,
  };
}

async function nextExchange(runtime: GatewayRuntime, state: PrivateChatRequestState, reply: string, signal: AbortSignal) {
  return runtime.privateChatExchange({
    schema: "morrow.private-chat.exchange.v1",
    action: "reply_and_listen",
    sessionId: state.sessionId,
    assistantName: state.assistantName,
    assistantReply: reply,
    sourceBindingId: state.sourceBindingId,
    courseId: state.courseId,
  }, signal);
}

export function registerPrivateChatTool(
  server: McpServer,
  runtime: GatewayRuntime,
  codec: { mint(payload: PrivateChatRequestState, context: ServerContext): Promise<string> },
): void {
  server.registerTool("morrow_private_chat", {
    title: "Start Morrow Private Chat",
    description: "Open the local Morrow Bridge drawer and relay a course-bound conversation through client sampling. The browser replaces asserted learner identities from a fresh complete course roster before any message reaches the assistant. The person closes the drawer to end and clear the session.",
    inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (_input, context): Promise<CallToolResult | InputRequiredResult> => {
    try {
      const capabilities = context.mcpReq.envelope
        ? (context.mcpReq.envelope as JsonObject)[CLIENT_CAPABILITIES_META_KEY]
        : server.server.getClientCapabilities();
      requireChat(isJsonObject(capabilities) && isJsonObject(capabilities.sampling), "This client does not provide MCP sampling.");
      const reported = server.server.getClientVersion();
      const assistantName = typeof reported?.name === "string" && reported.name.trim()
        ? reported.name.trim().slice(0, 200)
        : "Connected assistant";
      let state = context.mcpReq.requestState<PrivateChatRequestState>();
      const modern = context.mcpReq.envelope !== undefined || state !== undefined
        || Object.keys(context.mcpReq.inputResponses ?? {}).length > 0;
      if (!state) {
        requireChat(!Object.keys(context.mcpReq.inputResponses ?? {}).length && !context.mcpReq.droppedInputResponseKeys?.length,
          "An assistant response arrived without its Private Chat session.");
        const sessionId = randomUUID();
        const exchange = await runtime.privateChatExchange({
          schema: "morrow.private-chat.exchange.v1",
          action: "listen",
          sessionId,
          assistantName,
        }, context.mcpReq.signal);
        if (exchange.status === "closed") return resultClosed({ sessionId, turns: 0 });
        requireChat(exchange.status === "message" && exchange.sessionId === sessionId, "The local Private Chat did not return a protected message.");
        state = stateFromMessage(exchange, assistantName);
      } else {
        requireChat(state.workflow === "morrow.private-chat.v1" && state.assistantName === assistantName
          && state.turns >= 0 && state.turns < 100 && state.messages.length === state.turns * 2 + 1,
          "The Private Chat session state is invalid or belongs to another assistant.");
      }

      if (modern) {
        if (!Object.keys(context.mcpReq.inputResponses ?? {}).length) {
          return inputRequired({
            inputRequests: { private_chat_reply: inputRequired.createMessage(samplingRequest(state)) },
            requestState: await codec.mint(state, context),
          });
        }
        requireChat(!context.mcpReq.droppedInputResponseKeys?.length
          && Object.keys(context.mcpReq.inputResponses ?? {}).length === 1
          && Object.hasOwn(context.mcpReq.inputResponses ?? {}, "private_chat_reply"),
          "The assistant response does not match this Private Chat round.");
        const reply = sampleFromInput(context).content.text;
        const next = await nextExchange(runtime, state, reply, context.mcpReq.signal);
        const replied: PrivateChatRequestState = {
          ...state,
          messages: [...state.messages, { role: "assistant", text: reply }],
          turns: state.turns + 1,
        };
        if (next.status === "closed") return resultClosed(replied);
        requireChat(next.status === "message" && next.sessionId === state.sessionId
          && next.sourceBindingId === state.sourceBindingId && next.courseId === state.courseId
          && typeof next.protectedText === "string", "The Private Chat course changed or the next protected message is invalid.");
        const continued: PrivateChatRequestState = { ...replied, messages: [...replied.messages, { role: "user", text: next.protectedText }] };
        return inputRequired({
          inputRequests: { private_chat_reply: inputRequired.createMessage(samplingRequest(continued)) },
          requestState: await codec.mint(continued, context),
        });
      }

      for (;;) {
        requireChat(state.turns < 100, "Private Chat reached its 100-message limit. Close the drawer and start a new session.");
        const response = sampleSchema.parse(await context.mcpReq.requestSampling(samplingRequest(state)));
        const reply = response.content.text;
        const next = await nextExchange(runtime, state, reply, context.mcpReq.signal);
        state = { ...state, messages: [...state.messages, { role: "assistant", text: reply }], turns: state.turns + 1 };
        if (next.status === "closed") return resultClosed(state);
        requireChat(next.status === "message" && next.sessionId === state.sessionId
          && next.sourceBindingId === state.sourceBindingId && next.courseId === state.courseId
          && typeof next.protectedText === "string", "The Private Chat course changed or the next protected message is invalid.");
        state = { ...state, messages: [...state.messages, { role: "user", text: next.protectedText }] };
      }
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Private Chat unavailable. ${error instanceof PrivateChatError ? error.message : "Morrow could not validate the local relay or assistant response."}` }],
        structuredContent: { schema: "morrow.problem.v1", code: "private_chat_unavailable" },
      };
    }
  });
}
