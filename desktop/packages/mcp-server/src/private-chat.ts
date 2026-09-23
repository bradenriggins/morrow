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
import { isJsonObject, sha256Text, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
import { PrivateChatWaitEndedError, type GatewayRuntime } from "./runtime.js";

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
  readonly roundId?: string;
  readonly roundExpiresAt?: number;
};

const CONTINUATION_TTL_MS = 10 * 60 * 1_000;
/** The assistant replies one Private Chat session allows. The last one ends the chat. */
const REPLY_LIMIT = 100;
const MAX_CONTINUATION_CLAIMS = 2_048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type ContinuationClaim = { readonly replyDigest: string; readonly expiresAt: number };

export class PrivateChatContinuationLedger {
  private readonly claims = new Map<string, ContinuationClaim>();

  claim(roundId: string, reply: string, expiresAt: number, now = Date.now()): "accepted" | "duplicate" | "conflict" {
    for (const [id, claim] of this.claims) {
      if (claim.expiresAt <= now) this.claims.delete(id);
    }
    const replyDigest = sha256Text(reply);
    const prior = this.claims.get(roundId);
    if (prior) return prior.replyDigest === replyDigest ? "duplicate" : "conflict";
    if (this.claims.size >= MAX_CONTINUATION_CLAIMS) throw new PrivateChatError("Private Chat reached its protected continuation limit. Close this connection and start a new session.");
    this.claims.set(roundId, { replyDigest, expiresAt });
    return "accepted";
  }

  clear(): void {
    this.claims.clear();
  }
}

class PrivateChatError extends Error {}
function requireChat(value: unknown, message: string): asserts value {
  if (!value) throw new PrivateChatError(message);
}

function samplingRequest(state: PrivateChatRequestState): CreateMessageRequestParams {
  requireChat(JSON.stringify(state.messages).length <= 400_000, "Private Chat reached its protected transcript limit. Close the drawer and start a new session.");
  return {
    maxTokens: 4_000,
    includeContext: "none",
    systemPrompt: "You are the connected course assistant in Morrow Private Chat. Student A labels are stable pseudonyms for this one course connection, the same labels Morrow tool results use. Never infer, request, or reveal the original identity behind a label. Answer the educator's request using only the protected conversation. Do not claim that Morrow changed the learning platform unless a separate verified tool result proves it.",
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

function resultLimitReached(state: PrivateChatRequestState): CallToolResult {
  return {
    content: [{ type: "text", text: `Private Chat reached its ${REPLY_LIMIT}-message limit. Morrow showed the last reply in the drawer and ended the chat. To continue, the educator closes the drawer and asks you to start a new Private Chat.` }],
    structuredContent: {
      schema: "morrow.private-chat.v1",
      status: "limit_reached",
      sessionId: state.sessionId,
      sourceBindingId: state.sourceBindingId,
      courseId: state.courseId,
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

function stateForNextRound(state: PrivateChatRequestState): PrivateChatRequestState {
  return {
    ...state,
    roundId: randomUUID(),
    roundExpiresAt: Date.now() + CONTINUATION_TTL_MS,
  };
}

/**
 * Delivers the assistant's reply. It listens for the educator's next message
 * unless this reply is the last one the session allows: then the Bridge shows it
 * and ends the chat, so no message is taken that could not be answered.
 */
async function nextExchange(runtime: GatewayRuntime, state: PrivateChatRequestState, reply: string, signal: AbortSignal) {
  return runtime.privateChatExchange({
    schema: "morrow.private-chat.exchange.v1",
    action: state.turns + 1 >= REPLY_LIMIT ? "reply_at_limit" : "reply_and_listen",
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
  continuations = new PrivateChatContinuationLedger(),
): void {
  server.registerTool("morrow_private_chat", {
    title: "Start Morrow Private Chat",
    description: "Open the Morrow Bridge Private Chat drawer and relay a conversation about one connected course through client sampling. Before each message reaches the assistant, the Bridge checks it against a fresh, complete course roster and replaces each student name, email, login, and platform id it matches with that student's course label, the same label Morrow tool results use. Name-like words that match no student are sent only after the person confirms them. The person sees student names in the drawer; the assistant receives labels only. The person closes the drawer to end and clear the session.",
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
          && state.turns >= 0 && state.turns < REPLY_LIMIT && state.messages.length === state.turns * 2 + 1,
          "The Private Chat session state is invalid or belongs to another assistant.");
      }

      if (modern) {
        if (!Object.keys(context.mcpReq.inputResponses ?? {}).length) {
          const nextState = stateForNextRound(state);
          return inputRequired({
            inputRequests: { private_chat_reply: inputRequired.createMessage(samplingRequest(nextState)) },
            requestState: await codec.mint(nextState, context),
          });
        }
        requireChat(!context.mcpReq.droppedInputResponseKeys?.length
          && Object.keys(context.mcpReq.inputResponses ?? {}).length === 1
          && Object.hasOwn(context.mcpReq.inputResponses ?? {}, "private_chat_reply"),
          "The assistant response does not match this Private Chat round.");
        const reply = sampleFromInput(context).content.text;
        requireChat(typeof state.roundId === "string" && UUID.test(state.roundId)
          && Number.isSafeInteger(state.roundExpiresAt) && state.roundExpiresAt! > Date.now(),
          "The Private Chat continuation is missing or expired.");
        const claim = continuations.claim(state.roundId, reply, state.roundExpiresAt!);
        requireChat(claim === "accepted", claim === "conflict"
          ? "This Private Chat continuation was already answered with different content."
          : "This Private Chat continuation was already used.");
        const next = await nextExchange(runtime, state, reply, context.mcpReq.signal);
        const replied: PrivateChatRequestState = {
          ...state,
          messages: [...state.messages, { role: "assistant", text: reply }],
          turns: state.turns + 1,
        };
        if (replied.turns >= REPLY_LIMIT) return resultLimitReached(replied);
        if (next.status === "closed") return resultClosed(replied);
        requireChat(next.status === "message" && next.sessionId === state.sessionId
          && next.sourceBindingId === state.sourceBindingId && next.courseId === state.courseId
          && typeof next.protectedText === "string", "The Private Chat course changed or the next protected message is invalid.");
        const continued: PrivateChatRequestState = { ...replied, messages: [...replied.messages, { role: "user", text: next.protectedText }] };
        const nextState = stateForNextRound(continued);
        return inputRequired({
          inputRequests: { private_chat_reply: inputRequired.createMessage(samplingRequest(nextState)) },
          requestState: await codec.mint(nextState, context),
        });
      }

      for (;;) {
        const response = sampleSchema.parse(await context.mcpReq.requestSampling(samplingRequest(state)));
        const reply = response.content.text;
        const next = await nextExchange(runtime, state, reply, context.mcpReq.signal);
        state = { ...state, messages: [...state.messages, { role: "assistant", text: reply }], turns: state.turns + 1 };
        if (state.turns >= REPLY_LIMIT) return resultLimitReached(state);
        if (next.status === "closed") return resultClosed(state);
        requireChat(next.status === "message" && next.sessionId === state.sessionId
          && next.sourceBindingId === state.sourceBindingId && next.courseId === state.courseId
          && typeof next.protectedText === "string", "The Private Chat course changed or the next protected message is invalid.");
        state = { ...state, messages: [...state.messages, { role: "user", text: next.protectedText }] };
      }
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Private Chat unavailable. ${error instanceof PrivateChatError ? error.message
          : error instanceof PrivateChatWaitEndedError ? "No message was sent in time, so Morrow stopped waiting and cleared the drawer. Ask the assistant to start Private Chat again."
            : "Morrow could not validate the local relay or assistant response."}` }],
        structuredContent: { schema: "morrow.problem.v1", code: "private_chat_unavailable" },
      };
    }
  });
}
