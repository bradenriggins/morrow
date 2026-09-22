import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { McpServer } from "@modelcontextprotocol/server";
import { BLACKBOARD_TOOL_DEFINITIONS } from "@morrow/blackboard-learn-api";

/**
 * A Blackboard source that reports the constant session generation of 0 the
 * build before this one produced, with the real tool metadata so the Gateway
 * maps it as the Blackboard content-update route. Nothing here talks to
 * Blackboard: the plan is canned, and the dispatch and comparator routes refuse,
 * because a plan the Gateway refuses must never reach them.
 */
const SESSION_GENERATION = Number(process.env.FAKE_BLACKBOARD_SESSION_GENERATION || 0);
const DIGEST = "c".repeat(64);

function plan(input) {
  return {
    schema: "morrow.blackboard.content-patch.plan.v1",
    ok: true,
    tenantId: input.tenant_id,
    sourceBindingId: input.source_binding_id,
    courseId: input.course_id,
    contentId: input.content_id,
    before: { id: input.content_id, title: "Welcome" },
    beforeDigest: DIGEST,
    patch: input.patch,
    planDigest: DIGEST,
    reviewRequired: true,
    status: "api_configured_live_untested",
    effect_scope: {
      provider: "blackboard",
      origin: "https://fixture.invalid",
      sourceBindingId: input.source_binding_id,
      principalFingerprint: "d".repeat(64),
      sessionGeneration: SESSION_GENERATION,
    },
  };
}

function result(value) {
  return {
    content: [{ type: "text", text: "Blackboard fixture result." }],
    structuredContent: value,
    ...(value.ok === false ? { isError: true } : {}),
  };
}

await serveStdio(() => {
  const server = new McpServer({ name: "morrow-blackboard-constant-session-fixture", version: "1.0.0" });
  for (const tool of BLACKBOARD_TOOL_DEFINITIONS) {
    if (!["blackboard_plan_content_patch", "blackboard_apply_reviewed_content_patch", "blackboard_verify_content_patch"].includes(tool.name)) continue;
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      ...(tool.capability ? { _meta: { "io.morrow/capability": tool.capability } } : {}),
    }, async (input) => (tool.name === "blackboard_plan_content_patch"
      ? result(plan(input))
      : result({
        schema: "morrow.blackboard.result.v1",
        ok: false,
        resultState: "not_sent",
        problem: { code: "blackboard_patch_review_required", message: "This fixture sends nothing to Blackboard." },
      })));
  }
  return server;
});
