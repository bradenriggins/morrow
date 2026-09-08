import type { McpServer } from "@modelcontextprotocol/server";
import { registerBatchTools } from "./batch-tools.js";
import { registerOperationTools } from "./operation-tools.js";
import { registerQuizCheckTool } from "./quiz-check.js";
import { registerPageCorrectionTool } from "./page-correction.js";
import { registerItemBankFanOutTool } from "./item-bank-fan-out.js";
import { registerItemBankRepairTool } from "./item-bank-repair.js";
import { registerNewQuizItemLifecycleTools } from "./new-quiz-item-lifecycle.js";
import { registerNewQuizSettingsTool } from "./new-quiz-settings.js";
import { registerCanvasConversationTool } from "./canvas-conversations.js";
import { registerBlackboardContentPatchTool } from "./blackboard-content-patch.js";
import { registerBlackboardActionTools } from "./blackboard-actions.js";
import { createMorrowServer, type MorrowServerContext } from "./server.js";
import type { MorrowRuntime } from "./morrow-runtime.js";

export type { MorrowServerContext } from "./server.js";

export function createFullMorrowServer(runtime: MorrowRuntime, context: MorrowServerContext = {}): McpServer {
  // The batch store and window scheduler travel with the server so morrow_activity
  // can answer which groups run and which assistant holds each window.
  const server = createMorrowServer(runtime.gateway, () => runtime.health(), context, runtime);
  registerOperationTools(server, runtime.gateway);
  registerBatchTools(server, runtime);
  registerQuizCheckTool(server, runtime.gateway);
  registerPageCorrectionTool(server, runtime.gateway);
  registerItemBankFanOutTool(server, runtime.gateway);
  registerItemBankRepairTool(server, runtime.gateway);
  registerNewQuizItemLifecycleTools(server, runtime.gateway);
  registerNewQuizSettingsTool(server, runtime.gateway);
  registerCanvasConversationTool(server, runtime.gateway);
  registerBlackboardContentPatchTool(server, runtime.gateway);
  registerBlackboardActionTools(server, runtime.gateway, context.workspaceRoot);
  return server;
}
