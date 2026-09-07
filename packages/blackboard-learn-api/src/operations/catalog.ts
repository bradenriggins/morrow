import type { JsonObject } from "@morrow/contracts";
import { BLACKBOARD_OPERATION_MODULES } from "./index.js";

/**
 * What a reader has to know to use a row without over-reading it. Every claim
 * here is about this registry, not about a Blackboard tenant: no tenant has
 * been read.
 */
const NOTES = [
  "Each row names the Blackboard route its tool exists to call. Every course route also sends the integration-account, course-membership, and roster reads that tool states before it answers.",
  "entitlement is unknown wherever no tenant Swagger has stated the Learn entitlement the route needs. none marks a tool that sends no Blackboard request.",
  "private tools are hidden from Morrow's merged capability catalog. gatewayDispatchOnly tools are registered only when the Gateway starts this server for its own reserved dispatch.",
  "A write row names the tool that freezes and reviews the change and the tool that re-reads and compares it. Morrow sends one dispatch for each reviewed change.",
];

/**
 * The generated Blackboard REST catalog, one row for each registered tool.
 * `scripts/blackboard-catalog.mjs` writes it to
 * `artifacts/blackboard/blackboard-rest-catalog.json`.
 */
export function blackboardRestCatalog(): JsonObject {
  const tools = BLACKBOARD_OPERATION_MODULES.flatMap((module) => module.tools.map((tool) => ({
    module: module.id,
    tool: tool.name,
    provider: "blackboard",
    family: tool.capability?.family ?? null,
    method: tool.rest.method,
    pathTemplate: tool.rest.pathTemplate,
    access: tool.rest.access,
    entitlement: tool.rest.entitlement,
    reviewRoute: tool.rest.reviewRoute,
    readbackComparator: tool.rest.readbackComparator,
    private: tool.private,
    gatewayDispatchOnly: tool.gatewayDispatchOnly,
  })));
  return {
    schema: "morrow.blackboard-rest-catalog.v1",
    provider: "blackboard",
    registry: "packages/blackboard-learn-api/src/operations",
    generator: "scripts/blackboard-catalog.mjs",
    notes: NOTES,
    counts: {
      tools: tools.length,
      reads: tools.filter((row) => row.access === "read").length,
      writes: tools.filter((row) => row.access === "write").length,
      private: tools.filter((row) => row.private).length,
      gatewayDispatchOnly: tools.filter((row) => row.gatewayDispatchOnly).length,
      entitlementUnknown: tools.filter((row) => row.entitlement === "unknown").length,
    },
    tools,
  };
}
