import {
  CLIENT_CAPABILITIES_META_KEY,
  acceptedContent,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { isJsonObject, sha256Json, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
import type {
  BrowserEditAccessPrepared,
  BrowserEditAccessResult,
  BrowserEditAccessSelection,
  BrowserEditAccessSelectionInput,
  GatewayRuntime,
} from "./runtime.js";

const sourceBindingId = z.string().regex(/^[A-Za-z0-9_.:@-]{1,160}$/);
const confirmationSchema = z.strictObject({ confirm: z.literal(true) });
const confirmationRequestSchema = {
  type: "object" as const,
  properties: { confirm: { type: "boolean" as const, description: "Enable this exact Edit scope." } },
  required: ["confirm"],
};
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

export type EditAccessRequestState = {
  readonly workflow: "morrow.edit-access.v1";
  readonly inputDigest: string;
  readonly prepared: BrowserEditAccessPrepared;
};

export interface EditAccessStateMinter {
  mint(payload: EditAccessRequestState, context: ServerContext): Promise<string>;
}

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

function supportsForm(context: ServerContext, server: McpServer): boolean {
  const capabilities = context.mcpReq.envelope
    ? (context.mcpReq.envelope as JsonObject)[CLIENT_CAPABILITIES_META_KEY]
    : server.server.getClientCapabilities();
  return isJsonObject(capabilities) && isJsonObject(capabilities.elicitation);
}

function confirmationMessage(prepared: BrowserEditAccessPrepared): string {
  const courses = prepared.selections.map((selection) => {
    const categories = selection.enabledCategories.map((category) => category.label).join(", ");
    return `${selection.courseName} (course ${selection.courseId}, ${selection.site}; ${categories})`;
  }).join("\n");
  const message = `Enable Morrow Edit access for these exact current course connections:\n${courses}\n\nThis temporary Edit scope expires in 30 minutes. Confirm this Edit scope.`;
  if (message.length > 24_000) throw new Error("The selected courses exceed one confirmation form. Select fewer exact course connections.");
  return message;
}

function sameCategoryIds(left: readonly { readonly id: string }[], right: unknown): boolean {
  return Array.isArray(right) && right.length === left.length
    && left.every((category, index) => right[index] === category.id);
}

function currentBindingMatches(selection: BrowserEditAccessSelection, binding: JsonObject | undefined): boolean {
  const site = selection.provider === "canvas" ? binding?.origin : binding?.siteUrl;
  return binding?.sourceBindingId === selection.sourceBindingId
    && binding.provider === selection.provider
    && binding.courseId === selection.courseId
    && site === selection.site
    && binding.principalFingerprint === selection.principalFingerprint
    && binding.sessionGeneration === selection.sessionGeneration
    && binding.catalogDigest === selection.catalogDigest
    && binding.runtimeVerified === true;
}

function actualSelection(selection: BrowserEditAccessSelection, result: BrowserEditAccessResult): JsonObject {
  const binding = result.bindings.find((candidate) => candidate.sourceBindingId === selection.sourceBindingId);
  const permission = binding && isJsonObject(binding.editPermission) ? binding.editPermission : null;
  const actualMode = !binding ? "unavailable" : permission ? "edit" : "plan";
  const revision = binding?.editPolicyRevision;
  const expiresAt = permission?.expiresAt;
  const confirmed = result.outcome === "received" && currentBindingMatches(selection, binding) && (selection.enabledCategories.length > 0
    ? permission?.sourceBindingId === selection.sourceBindingId
      && permission.revision === selection.expectedPolicyRevision + 1
      && permission.catalogDigest === selection.catalogDigest
      && typeof expiresAt === "number" && Number.isSafeInteger(expiresAt) && expiresAt > Date.now()
      && sameCategoryIds(selection.enabledCategories, permission.enabledCategories)
    : !permission && (revision === selection.expectedPolicyRevision || revision === selection.expectedPolicyRevision + 1));
  return {
    sourceBindingId: selection.sourceBindingId,
    provider: selection.provider,
    courseId: selection.courseId,
    courseName: selection.courseName,
    site: selection.site,
    requestedMode: selection.enabledCategories.length ? "edit" : "plan",
    actualMode,
    ...(Number.isSafeInteger(revision) ? { editPolicyRevision: revision } : {}),
    confirmed,
  };
}

function resultFor(prepared: BrowserEditAccessPrepared, result: BrowserEditAccessResult): CallToolResult {
  const actual = prepared.selections.map((selection) => actualSelection(selection, result));
  const allConfirmed = result.outcome === "received" && actual.every((selection) => selection.confirmed === true);
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

async function currentNoChange(runtime: GatewayRuntime, prepared: BrowserEditAccessPrepared): Promise<CallToolResult> {
  try {
    const current = await runtime.prepareBrowserEditAccess(prepared.mode, prepared.selections.map((selection) => ({
      sourceBindingId: selection.sourceBindingId,
      ...(prepared.mode === "edit" ? { enabledCategories: selection.enabledCategories.map((category) => category.id) } : {}),
    })));
    return {
      content: [{ type: "text", text: "Morrow left the current course access unchanged." }],
      structuredContent: {
        schema: "morrow.edit-access.v1",
        ok: true,
        mode: current.mode,
        outcome: "not_sent",
        selections: current.selections.map((selection) => ({
          sourceBindingId: selection.sourceBindingId,
          courseId: selection.courseId,
          courseName: selection.courseName,
          site: selection.site,
          editPolicyRevision: selection.expectedPolicyRevision,
          currentStateRead: true,
        })),
      },
    };
  } catch {
    return problem("edit_access_current_state_unavailable", "Morrow left access unchanged, but could not read the current course connections.");
  }
}

export function registerEditAccessTool(
  server: McpServer,
  runtime: GatewayRuntime,
  codec: EditAccessStateMinter,
): void {
  server.registerTool("morrow_request_edit_access", {
    title: "Set selected course access",
    description: "Ask the connected client to show one native confirmation form before Morrow enables Edit for exact current course connections and selected categories. Set Plan to revoke selected Edit access with a fresh current readback.",
    inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input, context): Promise<CallToolResult | InputRequiredResult> => {
    const state = context.mcpReq.requestState<EditAccessRequestState>();
    if (!state) {
      if (Object.keys(context.mcpReq.inputResponses ?? {}).length || context.mcpReq.droppedInputResponseKeys?.length) {
        return problem("edit_access_state_missing", "Morrow could not verify this confirmation. Start a new access request.");
      }
      let prepared: BrowserEditAccessPrepared;
      try {
        prepared = await runtime.prepareBrowserEditAccess(input.mode, selections(input));
      } catch {
        return problem("edit_access_preflight_refused", "Morrow could not verify every selected current course connection.");
      }
      if (input.mode === "plan") {
        try {
          return resultFor(prepared, await runtime.applyBrowserEditAccess(prepared));
        } catch {
          return problem("edit_access_plan_refused", "Morrow could not set Plan access because the selected current course connection changed.");
        }
      }
      if (!supportsForm(context, server)) {
        return problem("edit_access_form_unsupported", "This client cannot show Morrow's required native confirmation form. Morrow kept access unchanged.");
      }
      let message: string;
      try {
        message = confirmationMessage(prepared);
      } catch {
        return problem("edit_access_confirmation_too_large", "The selected courses do not fit one native confirmation form. Select fewer current course connections.");
      }
      const next: EditAccessRequestState = {
        workflow: "morrow.edit-access.v1",
        inputDigest: sha256Json(input),
        prepared,
      };
      return inputRequired({
        inputRequests: { edit_access: inputRequired.elicit({ message, requestedSchema: confirmationRequestSchema }) },
        requestState: await codec.mint(next, context),
      });
    }

    if (state.workflow !== "morrow.edit-access.v1" || state.inputDigest !== sha256Json(input) || state.prepared.mode !== "edit") {
      return problem("edit_access_state_stale", "The selected access request changed. Start a new access request.");
    }
    const response = inputResponse(context.mcpReq.inputResponses, "edit_access");
    const confirmed = acceptedContent(context.mcpReq.inputResponses, "edit_access", confirmationSchema);
    if (context.mcpReq.droppedInputResponseKeys?.length || response.kind !== "elicit" || response.action !== "accept" || !confirmed) {
      return currentNoChange(runtime, state.prepared);
    }
    try {
      return resultFor(state.prepared, await runtime.applyBrowserEditAccess(state.prepared));
    } catch {
      return problem("edit_access_state_stale", "The selected current course connection changed before confirmation. Morrow did not set access.");
    }
  });
}
