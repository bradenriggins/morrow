#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { dirname, join } from "node:path";
import { LearnerVault } from "@morrow/gateway-core";
import { loadBlackboardLearnConfig } from "./config.js";
import { blackboardEffectStatePath } from "./operations/effect-receipts.js";
import { blackboardSessionStatePath } from "./operations/effect-scope.js";
import { BlackboardLearnRuntime } from "./runtime.js";
import { createBlackboardLearnMcpServer } from "./server.js";

const effectDispatchSecret = process.env.MORROW_BLACKBOARD_EFFECT_DISPATCH_SECRET;
const runtime = new BlackboardLearnRuntime(await loadBlackboardLearnConfig(), {
  effectDispatchSecret,
  learnerVault: new LearnerVault(join(dirname(blackboardSessionStatePath(process.env)), "blackboard-learners.json")),
  // The Blackboard state that has to outlive this process: which account and
  // credential each connection acts as, and since when, and every effect
  // receipt this installation has already spent.
  sessionStatePath: blackboardSessionStatePath(process.env),
  effectStatePath: blackboardEffectStatePath(process.env),
});
console.error(`[morrow-blackboard-learn-api] status=api_configured_live_untested tenants=${(runtime.health().tenantCount as number)}`);
await serveStdio(() => createBlackboardLearnMcpServer(runtime, {
  includePrivateDispatch: process.env.MORROW_BLACKBOARD_GATEWAY_INTERNAL === "1",
}));

export { loadBlackboardLearnConfig, publicBlackboardTenant } from "./config.js";
export { BlackboardLearnRuntime } from "./runtime.js";
export { createBlackboardLearnMcpServer } from "./server.js";
export { BLACKBOARD_OPERATION_MODULES, BLACKBOARD_TOOL_DEFINITIONS, type BlackboardOperationModule, type BlackboardRestRoute, type BlackboardToolDefinition } from "./operations/index.js";
export { blackboardRestCatalog } from "./operations/catalog.js";
export { BlackboardApiError, type BlackboardContentPatchPlan, type BlackboardCourseBinding, type BlackboardTenant } from "./types.js";
export { signBlackboardEffectGrant, type BlackboardEffectGrant } from "./effect-grant.js";
