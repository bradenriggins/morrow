import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { JsonObject } from "@morrow/contracts";
import { describe, expect, it, vi } from "vitest";
import { createMorrowServer } from "../src/server.js";
import { PrivateChatBridgeProblemError, PrivateChatWaitEndedError, type GatewayRuntime } from "../src/runtime.js";

function fixture({ closeImmediately = false, continueOnce = false } = {}) {
  const calls: JsonObject[] = [];
  let replies = 0;
  const runtime = {
    catalog: { tools: [] },
    config: { upstreams: [] },
    redactMcpEgress: async (value: JsonObject) => value,
    privateChatExchange: async (input: JsonObject) => {
      calls.push(structuredClone(input));
      if (closeImmediately) return { schema: "morrow.private-chat.exchange.v1", status: "closed" };
      if (input.action === "listen") return {
        schema: "morrow.private-chat.exchange.v1",
        status: "message",
        sessionId: input.sessionId,
        sourceBindingId: "canvas:course-42",
        courseId: "42",
        protectedText: "Review Student A1's latest work.",
      };
      if (continueOnce && replies++ === 0) return {
        schema: "morrow.private-chat.exchange.v1",
        status: "message",
        sessionId: input.sessionId,
        sourceBindingId: input.sourceBindingId,
        courseId: input.courseId,
        protectedText: "Compare Student A1 with Student A2.",
      };
      return { schema: "morrow.private-chat.exchange.v1", status: "closed" };
    },
  } as unknown as GatewayRuntime;
  return { runtime, calls };
}

/** A Bridge whose educator always sends another message, so only the reply limit ends the chat. */
function endlessChat() {
  const calls: JsonObject[] = [];
  const runtime = {
    catalog: { tools: [] },
    config: { upstreams: [] },
    redactMcpEgress: async (value: JsonObject) => value,
    privateChatExchange: async (input: JsonObject) => {
      calls.push(structuredClone(input));
      if (input.action === "reply_at_limit") return { schema: "morrow.private-chat.exchange.v1", status: "closed" };
      return {
        schema: "morrow.private-chat.exchange.v1",
        status: "message",
        sessionId: input.sessionId,
        sourceBindingId: "canvas:course-42",
        courseId: "42",
        protectedText: `Message ${calls.length}.`,
      };
    },
  } as unknown as GatewayRuntime;
  return { runtime, calls };
}

const LIMIT_TEXT = "Private Chat reached its 100-message limit, so Morrow ended the chat after the last reply. To continue, the educator closes the drawer and asks you to start a new Private Chat.";

/** The last reply is delivered without taking another message, so no educator message goes unanswered. */
function expectEndedAtLimit(calls: readonly JsonObject[]) {
  expect(calls.filter((call) => call.action === "listen")).toHaveLength(1);
  expect(calls.filter((call) => call.action === "reply_and_listen")).toHaveLength(99);
  expect(calls.at(-1)).toMatchObject({ action: "reply_at_limit", assistantReply: "Reply 100.", sourceBindingId: "canvas:course-42", courseId: "42" });
  expect(calls).toHaveLength(101);
}

describe("Morrow Private Chat", () => {
  it("ends at the 100-message limit on the legacy era without taking another message", async () => {
    const { runtime, calls } = endlessChat();
    const client = new Client({ name: "Codex", version: "1" }, { capabilities: { sampling: {} }, versionNegotiation: { mode: "legacy" } });
    let replies = 0;
    client.setRequestHandler("sampling/createMessage", async () => {
      replies += 1;
      return { model: "local-test", role: "assistant", content: { type: "text", text: `Reply ${replies}.` }, stopReason: "endTurn" };
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    try {
      const result = await client.callTool({ name: "morrow_private_chat", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect((result.content as { text: string }[])[0]!.text).toBe(LIMIT_TEXT);
      expect(result.structuredContent).toMatchObject({ schema: "morrow.private-chat.v1", status: "limit_reached", turns: 100 });
      expect(replies).toBe(100);
      expectEndedAtLimit(calls);
    } finally { await client.close(); await server.close(); }
  });

  it("ends at the 100-message limit on 2026-07-28 without taking another message", async () => {
    const { runtime, calls } = endlessChat();
    const client = new Client({ name: "Codex", version: "1" }, { capabilities: { sampling: {} }, versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    try {
      let round = await client.callTool({ name: "morrow_private_chat", arguments: {} }, { allowInputRequired: true }) as unknown as { requestState: string };
      let result: Awaited<ReturnType<Client["callTool"]>> | undefined;
      for (let reply = 1; reply <= 100; reply += 1) {
        result = await client.callTool({
          name: "morrow_private_chat",
          arguments: {},
          requestState: round.requestState,
          inputResponses: {
            private_chat_reply: { model: "local-test", role: "assistant", content: { type: "text", text: `Reply ${reply}.` } },
          },
        } as Parameters<Client["callTool"]>[0], { allowInputRequired: true });
        if (reply < 100) {
          expect(result.resultType, `reply ${reply}`).toBe("input_required");
          round = result as unknown as { requestState: string };
        }
      }
      expect(result!.isError).not.toBe(true);
      expect((result!.content as { text: string }[])[0]!.text).toBe(LIMIT_TEXT);
      expect(result!.structuredContent).toMatchObject({ schema: "morrow.private-chat.v1", status: "limit_reached", turns: 100 });
      expectEndedAtLimit(calls);
    } finally { await client.close(); await server.close(); }
  });

  it("uses push sampling on the legacy era and sends only the protected transcript", async () => {
    const { runtime, calls } = fixture();
    const client = new Client({ name: "Codex", version: "1" }, { capabilities: { sampling: {} }, versionNegotiation: { mode: "legacy" } });
    const sampled: string[] = [];
    client.setRequestHandler("sampling/createMessage", async ({ params }) => {
      const text = (params.messages.at(-1)!.content as { text: string }).text;
      sampled.push(text);
      return { model: "local-test", role: "assistant", content: { type: "text", text: "Student A1 needs feedback." }, stopReason: "endTurn" };
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    try {
      const result = await client.callTool({ name: "morrow_private_chat", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect((result.structuredContent as JsonObject).status).toBe("closed");
      expect(sampled).toEqual(["Review Student A1's latest work."]);
      expect(calls).toHaveLength(2);
      expect(calls[1]).toMatchObject({
        action: "reply_and_listen",
        assistantReply: "Student A1 needs feedback.",
        sourceBindingId: "canvas:course-42",
        courseId: "42",
      });
      expect(JSON.stringify(calls)).not.toMatch(/Michaela|example\.edu|school_id/iu);
    } finally { await client.close(); await server.close(); }
  });

  // A legacy-era client may show a consent prompt, or its model may take minutes to write a reply.
  // The assistant's reply decides the wait, not the MCP SDK's 60-second request default.
  it("relays a legacy-era assistant reply that takes more than a minute", async () => {
    const { runtime, calls } = fixture();
    const client = new Client({ name: "VS Code", version: "1" }, { capabilities: { sampling: {} }, versionNegotiation: { mode: "legacy" } });
    let reply: (() => void) | undefined;
    const asked = new Promise<void>((resolveAsked) => {
      client.setRequestHandler("sampling/createMessage", async () => {
        resolveAsked();
        await new Promise<void>((resolveReply) => { reply = resolveReply; });
        return { model: "local-test", role: "assistant", content: { type: "text", text: "Student A1 needs feedback." }, stopReason: "endTurn" };
      });
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = client.callTool({ name: "morrow_private_chat", arguments: {} }, { timeout: 60 * 60_000 });
      await asked;
      await vi.advanceTimersByTimeAsync(9 * 60_000);
      reply!();
      const result = await pending;
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ schema: "morrow.private-chat.v1", status: "closed", turns: 1 });
      expect(calls.map((call) => call.action)).toEqual(["listen", "reply_and_listen"]);
    } finally { vi.useRealTimers(); reply?.(); await client.close(); await server.close(); }
  });

  it("says the assistant did not reply in time when a legacy-era reply takes more than 10 minutes", async () => {
    const { runtime, calls } = fixture();
    const client = new Client({ name: "VS Code", version: "1" }, { capabilities: { sampling: {} }, versionNegotiation: { mode: "legacy" } });
    let reply: (() => void) | undefined;
    const asked = new Promise<void>((resolveAsked) => {
      client.setRequestHandler("sampling/createMessage", async () => {
        resolveAsked();
        await new Promise<void>((resolveReply) => { reply = resolveReply; });
        return { model: "local-test", role: "assistant", content: { type: "text", text: "Too late." }, stopReason: "endTurn" };
      });
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = client.callTool({ name: "morrow_private_chat", arguments: {} }, { timeout: 60 * 60_000 });
      await asked;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      const result = await pending;
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0]!.text).toBe(
        "Private Chat unavailable. The assistant did not reply within 10 minutes, so Morrow stopped Private Chat. Close the Private Chat drawer, then ask the assistant to start Private Chat again.",
      );
      expect(result.structuredContent).toMatchObject({ schema: "morrow.problem.v1", code: "private_chat_unavailable" });
      expect(calls.map((call) => call.action)).toEqual(["listen"]);
    } finally { vi.useRealTimers(); reply?.(); await client.close(); await server.close(); }
  });

  it("uses signed input_required continuation on 2026-07-28, repeats, and refuses a changed state token", async () => {
    const { runtime, calls } = fixture({ continueOnce: true });
    const client = new Client({ name: "Codex", version: "1" }, { capabilities: { sampling: {} }, versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    try {
      const round = await client.callTool({ name: "morrow_private_chat", arguments: {} }, { allowInputRequired: true }) as unknown as {
        requestState: string;
        inputRequests: { private_chat_reply: { params: { messages: { content: { text: string } }[] } } };
      };
      expect(round.inputRequests.private_chat_reply.params.messages.at(-1)!.content.text).toBe("Review Student A1's latest work.");
      expect(calls).toHaveLength(1);
      const retry = (requestState: string) => client.callTool({
        name: "morrow_private_chat",
        arguments: {},
        requestState,
        inputResponses: {
          private_chat_reply: {
            model: "local-test",
            role: "assistant",
            content: { type: "text", text: "Student A1 needs feedback." },
          },
        },
      } as Parameters<Client["callTool"]>[0], { allowInputRequired: true });
      await expect(retry(`${round.requestState.slice(0, -4)}AAAA`)).rejects.toThrow("requestState");
      const secondRound = await retry(round.requestState) as unknown as {
        requestState: string;
        inputRequests: { private_chat_reply: { params: { messages: { content: { text: string } }[] } } };
      };
      expect(secondRound.inputRequests.private_chat_reply.params.messages.at(-1)!.content.text).toBe("Compare Student A1 with Student A2.");
      expect(calls).toHaveLength(2);
      const replay = await retry(round.requestState);
      expect(replay).toMatchObject({
        isError: true,
        structuredContent: { schema: "morrow.problem.v1", code: "private_chat_unavailable" },
      });
      expect(replay.content?.[0]).toMatchObject({ type: "text", text: expect.stringContaining("already used") });
      expect(calls).toHaveLength(2);
      const result = await retry(secondRound.requestState);
      expect(result.isError).not.toBe(true);
      expect((result.structuredContent as JsonObject).status).toBe("closed");
      expect(calls).toHaveLength(3);
    } finally { await client.close(); await server.close(); }
  });

  it("returns a normal closed result when the drawer closes before its first message", async () => {
    const { runtime, calls } = fixture({ closeImmediately: true });
    const client = new Client({ name: "Codex", version: "1" }, { capabilities: { sampling: {} }, versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    try {
      const result = await client.callTool({ name: "morrow_private_chat", arguments: {} }, { allowInputRequired: true });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ status: "closed", turns: 0 });
      expect(calls).toHaveLength(1);
    } finally { await client.close(); await server.close(); }
  });

  it("says Private Chat stopped waiting when no message arrived in time", async () => {
    const runtime = {
      catalog: { tools: [] },
      config: { upstreams: [] },
      redactMcpEgress: async (value: JsonObject) => value,
      privateChatExchange: async () => { throw new PrivateChatWaitEndedError(); },
    } as unknown as GatewayRuntime;
    const client = new Client({ name: "Codex", version: "1" }, { capabilities: { sampling: {} }, versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    try {
      const result = await client.callTool({ name: "morrow_private_chat", arguments: {} }, { allowInputRequired: true });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0]!.text).toBe(
        "Private Chat unavailable. No message was sent in time, so Morrow stopped waiting and cleared the drawer. Ask the assistant to start Private Chat again.",
      );
    } finally { await client.close(); await server.close(); }
  });

  // Each Bridge reason gets the step that fixes it. Only a real validation failure says "could not validate".
  it.each([
    ["bridge_unavailable", "Morrow Bridge is not connected to Morrow. Open Chrome and open the Morrow Bridge popup, which shows the step that connects it. Then ask the assistant to start Private Chat again.", "bridge_unavailable"],
    ["bridge_port_in_use", "Another Morrow is already connected to Morrow Bridge, so this Morrow cannot open Private Chat. Close the other Morrow, or use one Morrow for all your assistants.", "bridge_port_in_use"],
    ["bridge_outcome_unknown", "Morrow Bridge stopped answering, so Morrow ended Private Chat. Close the Private Chat drawer if it is still open, then ask the assistant to start Private Chat again.", "bridge_outcome_unknown"],
    ["bridge_request_capacity", "Morrow Bridge is busy with its current requests. Ask the assistant to start Private Chat again after they finish.", "bridge_request_capacity"],
    ["private_chat_busy", "Another Private Chat is already open in Morrow Bridge. Close that Private Chat drawer, then ask the assistant to start Private Chat again.", "private_chat_busy"],
    ["private_chat_scope_changed", "Morrow Bridge could not continue this Private Chat. Close the Private Chat drawer if it is still open, then ask the assistant to start Private Chat again.", undefined],
    ["", "Morrow Bridge could not continue this Private Chat. Close the Private Chat drawer if it is still open, then ask the assistant to start Private Chat again.", undefined],
  ])("names the Bridge's %j reason instead of a validation failure", async (code, text, sourceCode) => {
    const runtime = {
      catalog: { tools: [] },
      config: { upstreams: [] },
      redactMcpEgress: async (value: JsonObject) => value,
      privateChatExchange: async () => { throw new PrivateChatBridgeProblemError(code); },
    } as unknown as GatewayRuntime;
    const client = new Client({ name: "Codex", version: "1" }, { capabilities: { sampling: {} }, versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    try {
      const result = await client.callTool({ name: "morrow_private_chat", arguments: {} }, { allowInputRequired: true });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0]!.text).toBe(`Private Chat unavailable. ${text}`);
      expect(result.structuredContent).toEqual({ schema: "morrow.problem.v1", code: "private_chat_unavailable", ...(sourceCode ? { sourceCode } : {}) });
    } finally { await client.close(); await server.close(); }
  });

  it("keeps the validation sentence for a relay result Morrow could not validate", async () => {
    const runtime = {
      catalog: { tools: [] },
      config: { upstreams: [] },
      redactMcpEgress: async (value: JsonObject) => value,
      privateChatExchange: async () => { throw new Error("The Private Chat relay returned an invalid protected message."); },
    } as unknown as GatewayRuntime;
    const client = new Client({ name: "Codex", version: "1" }, { capabilities: { sampling: {} }, versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    try {
      const result = await client.callTool({ name: "morrow_private_chat", arguments: {} }, { allowInputRequired: true });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0]!.text).toBe("Private Chat unavailable. Morrow could not validate the local relay or assistant response.");
      expect(result.structuredContent).toEqual({ schema: "morrow.problem.v1", code: "private_chat_unavailable" });
    } finally { await client.close(); await server.close(); }
  });

  it("relays a concurrently replayed continuation exactly once", async () => {
    const { runtime, calls } = fixture({ continueOnce: true });
    const client = new Client({ name: "Codex", version: "1" }, { capabilities: { sampling: {} }, versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    try {
      const round = await client.callTool({ name: "morrow_private_chat", arguments: {} }, { allowInputRequired: true }) as unknown as { requestState: string };
      const continueRound = () => client.callTool({
        name: "morrow_private_chat",
        arguments: {},
        requestState: round.requestState,
        inputResponses: {
          private_chat_reply: {
            model: "local-test",
            role: "assistant",
            content: { type: "text", text: "Student A1 needs feedback." },
          },
        },
      } as Parameters<Client["callTool"]>[0], { allowInputRequired: true });

      const results = await Promise.all([continueRound(), continueRound()]);
      expect(results.filter((result) => result.isError === true)).toHaveLength(1);
      expect(results.filter((result) => result.resultType === "input_required")).toHaveLength(1);
      expect(calls).toHaveLength(2);
    } finally { await client.close(); await server.close(); }
  });
});
