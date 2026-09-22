import * as z from "zod/v4";
import { blackboardTool, type BlackboardOperationModule } from "./definition.js";

/**
 * The local configuration check. It reads this server's own configuration and
 * sends no Blackboard request, so it carries no capability block: it is not a
 * Morrow catalog capability.
 */
export const blackboardHealthModule: BlackboardOperationModule = {
  id: "health",
  tools: [
    blackboardTool({
      name: "morrow_blackboard_health",
      title: "Check Blackboard REST configuration",
      description: "Show configured Blackboard Learn REST tenants. A configured status does not prove a live Blackboard connection.",
      private: false,
      gatewayDispatchOnly: false,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      capability: null,
      rest: { method: null, pathTemplate: null, access: "read", entitlement: "none", reviewRoute: null, readbackComparator: null },
      run: async (runtime) => runtime.health(),
    }),
  ],
};
