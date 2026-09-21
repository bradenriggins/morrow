import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { describe, expect, it, vi } from "vitest";
import { createMorrowServer } from "../src/server.js";
import type { BrowserEditAccessPrepared, BrowserEditAccessResult, GatewayRuntime } from "../src/runtime.js";

const input = {
  mode: "edit" as const,
  selections: [
    { source_binding_id: "canvas-bio", enabled_categories: ["assignment_due_at"] },
    { source_binding_id: "moodle-chem", enabled_categories: ["moodle_page_content"] },
  ],
};

const prepared: BrowserEditAccessPrepared = {
  mode: "edit",
  selections: [
    {
      sourceBindingId: "canvas-bio", provider: "canvas", courseId: "42", courseName: "Biology", site: "https://canvas.example.edu",
      principalFingerprint: "a".repeat(64), sessionGeneration: 4, catalogDigest: "b".repeat(64), expectedPolicyRevision: 2,
      enabledCategories: [{ id: "assignment_due_at", label: "Assignment due dates", description: "Change one assignment due date.", destructive: false, unchecked: false }],
    },
    {
      sourceBindingId: "moodle-chem", provider: "moodle", courseId: "51", courseName: "Chemistry", site: "https://moodle.example.edu",
      principalFingerprint: "c".repeat(64), sessionGeneration: 9, catalogDigest: "d".repeat(64), expectedPolicyRevision: 7,
      enabledCategories: [{ id: "moodle_page_content", label: "Page content", description: "Change a Moodle Page.", destructive: false, unchecked: false }],
    },
  ],
};

const planPrepared: BrowserEditAccessPrepared = {
  mode: "plan",
  selections: prepared.selections.map((selection) => ({ ...selection, enabledCategories: [] })),
};

function fixture() {
  const result: BrowserEditAccessResult = {
    mode: "edit",
    outcome: "received",
    command: { schema: "morrow.browser-edit-policy-set.v1", ok: true },
    bindings: prepared.selections.map((selection) => ({
      sourceBindingId: selection.sourceBindingId,
      provider: selection.provider,
      courseId: selection.courseId,
      ...(selection.provider === "canvas" ? { origin: selection.site } : { siteUrl: selection.site }),
      principalFingerprint: selection.principalFingerprint,
      sessionGeneration: selection.sessionGeneration,
      catalogDigest: selection.catalogDigest,
      runtimeVerified: true,
      editPolicyRevision: selection.expectedPolicyRevision + 1,
      editPermission: {
        sourceBindingId: selection.sourceBindingId,
        revision: selection.expectedPolicyRevision + 1,
        catalogDigest: selection.catalogDigest,
        expiresAt: Date.now() + 30 * 60 * 1_000,
        enabledCategories: selection.enabledCategories.map((category) => category.id),
      },
    })),
  };
  const runtime = {
    catalog: { tools: [], digest: "e".repeat(64) },
    config: { toolSurface: "compact", upstreams: [] },
    prepareBrowserEditAccess: vi.fn().mockResolvedValue(prepared),
    applyBrowserEditAccess: vi.fn().mockResolvedValue(result),
  } as unknown as GatewayRuntime;
  return { runtime, prepare: runtime.prepareBrowserEditAccess as ReturnType<typeof vi.fn>, apply: runtime.applyBrowserEditAccess as ReturnType<typeof vi.fn> };
}

async function connected(runtime: GatewayRuntime) {
  const client = new Client(
    { name: "edit-access-test", version: "1" },
    { capabilities: { elicitation: {} }, versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
  await client.connect(a);
  return { client, server };
}

describe("conversational Edit access", () => {
  it("seals multiple exact course scopes in one native confirmation before applying them", async () => {
    const { runtime, prepare, apply } = fixture();
    const { client, server } = await connected(runtime);
    try {
      const round = await client.callTool({ name: "morrow_request_edit_access", arguments: input }, { allowInputRequired: true }) as unknown as {
        requestState: string;
        inputRequests: { edit_access: { params: { message: string } } };
      };
      expect(round.requestState).toMatch(/^v1\./);
      expect(round.inputRequests.edit_access.params.message).toContain("Biology (course 42, https://canvas.example.edu; Assignment due dates)");
      expect(round.inputRequests.edit_access.params.message).toContain("Chemistry (course 51, https://moodle.example.edu; Page content)");
      expect(round.inputRequests.edit_access.params.message).toContain("expires in 30 minutes");
      const confirmed = await client.callTool({
        name: "morrow_request_edit_access",
        arguments: input,
        requestState: round.requestState,
        inputResponses: { edit_access: { action: "accept", content: { confirm: true } } },
      });
      expect(confirmed.isError, JSON.stringify(confirmed.content)).not.toBe(true);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(apply).toHaveBeenCalledWith(prepared);
      expect(confirmed.structuredContent).toMatchObject({ schema: "morrow.edit-access.v1", ok: true, mode: "edit", outcome: "received" });

      prepare.mockResolvedValueOnce(planPrepared);
      apply.mockResolvedValueOnce({
        mode: "plan",
        outcome: "received",
        command: { schema: "morrow.browser-edit-policy-set.v1", ok: true },
        bindings: planPrepared.selections.map((selection) => ({
          sourceBindingId: selection.sourceBindingId,
          provider: selection.provider,
          courseId: selection.courseId,
          ...(selection.provider === "canvas" ? { origin: selection.site } : { siteUrl: selection.site }),
          principalFingerprint: selection.principalFingerprint,
          sessionGeneration: selection.sessionGeneration,
          catalogDigest: selection.catalogDigest,
          runtimeVerified: true,
          editPolicyRevision: selection.expectedPolicyRevision + 1,
        })),
      } satisfies BrowserEditAccessResult);
      const revoked = await client.callTool({
        name: "morrow_request_edit_access",
        arguments: { mode: "plan", selections: input.selections.map((selection) => ({ source_binding_id: selection.source_binding_id })) },
      });
      expect(revoked.isError, JSON.stringify(revoked.content)).not.toBe(true);
      expect(revoked).not.toHaveProperty("inputRequests");
      expect(apply).toHaveBeenLastCalledWith(planPrepared);
      expect(revoked.structuredContent).toMatchObject({ schema: "morrow.edit-access.v1", ok: true, mode: "plan", outcome: "received" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("states that a selected action removes course content before the person confirms", async () => {
    const { runtime, prepare } = fixture();
    prepare.mockResolvedValueOnce({
      mode: "edit",
      selections: [{
        ...prepared.selections[1]!,
        enabledCategories: [{
          id: "action:moodle:moodle_delete_book_chapter",
          label: "Delete a Book chapter",
          description: "It removes or replaces saved course content for everyone in the course, and Morrow cannot undo it.",
          destructive: true,
          unchecked: true,
        }],
      }],
    } satisfies BrowserEditAccessPrepared);
    const { client, server } = await connected(runtime);
    try {
      const round = await client.callTool({
        name: "morrow_request_edit_access",
        arguments: { mode: "edit", selections: [{ source_binding_id: "moodle-chem", enabled_categories: ["action:moodle:moodle_delete_book_chapter"] }] },
      }, { allowInputRequired: true }) as unknown as { inputRequests: { edit_access: { params: { message: string } } } };
      const message = round.inputRequests.edit_access.params.message;
      expect(message).toContain("1 selected action removes course content: Delete a Book chapter.");
      expect(message).toContain("Morrow cannot check the saved result for 1 selected action: Delete a Book chapter.");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("caps the confirmation label list at six per course", async () => {
    const { runtime, prepare } = fixture();
    const manyCategories = Array.from({ length: 8 }, (_, index) => ({
      id: `assignment_field_${index}`,
      label: `Assignment field ${index}`,
      description: "Change one assignment field.",
      destructive: false,
      unchecked: false,
    }));
    prepare.mockResolvedValueOnce({
      mode: "edit",
      selections: [{ ...prepared.selections[0]!, enabledCategories: manyCategories }],
    } satisfies BrowserEditAccessPrepared);
    const { client, server } = await connected(runtime);
    try {
      const round = await client.callTool({
        name: "morrow_request_edit_access",
        arguments: { mode: "edit", selections: [{ source_binding_id: "canvas-bio", enabled_categories: manyCategories.map((category) => category.id) }] },
      }, { allowInputRequired: true }) as unknown as { inputRequests: { edit_access: { params: { message: string } } } };
      const message = round.inputRequests.edit_access.params.message;
      expect(message).toContain(
        "Biology (course 42, https://canvas.example.edu; Assignment field 0, Assignment field 1, Assignment field 2, "
        + "Assignment field 3, Assignment field 4, Assignment field 5, and 2 more actions)",
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not apply after cancellation and refuses stale confirmation", async () => {
    const { runtime, apply } = fixture();
    const { client, server } = await connected(runtime);
    try {
      const cancelledRound = await client.callTool({ name: "morrow_request_edit_access", arguments: input }, { allowInputRequired: true }) as unknown as { requestState: string };
      const cancelled = await client.callTool({
        name: "morrow_request_edit_access",
        arguments: input,
        requestState: cancelledRound.requestState,
        inputResponses: { edit_access: { action: "cancel" } },
      });
      expect(cancelled.isError).not.toBe(true);
      expect(apply).not.toHaveBeenCalled();

      const staleRound = await client.callTool({ name: "morrow_request_edit_access", arguments: input }, { allowInputRequired: true }) as unknown as { requestState: string };
      apply.mockRejectedValueOnce(new Error("stale binding"));
      const stale = await client.callTool({
        name: "morrow_request_edit_access",
        arguments: input,
        requestState: staleRound.requestState,
        inputResponses: { edit_access: { action: "accept", content: { confirm: true } } },
      });
      expect(stale.isError).toBe(true);
      expect(stale.structuredContent).toMatchObject({ code: "edit_access_state_stale" });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
