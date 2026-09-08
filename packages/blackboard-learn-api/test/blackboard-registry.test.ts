import { readFile } from "node:fs/promises";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { describe, expect, it } from "vitest";
import { deriveBlackboardSourceBindingId } from "../src/binding.js";
import { blackboardRestCatalog } from "../src/operations/catalog.js";
import { BLACKBOARD_OPERATION_MODULES, BLACKBOARD_TOOL_DEFINITIONS } from "../src/operations/index.js";
import { BlackboardLearnRuntime } from "../src/runtime.js";
import { createBlackboardLearnMcpServer } from "../src/server.js";
import type { BlackboardTenant } from "../src/types.js";

/** The Gateway's own private-name list, which this registry has to match. */
const GATEWAY_RUNTIME = new URL("../../mcp-server/src/runtime.ts", import.meta.url);
/** The catalog this registry generates, as `scripts/blackboard-catalog.mjs` wrote it. */
const CATALOG_ARTIFACT = new URL("../../../artifacts/blackboard/blackboard-rest-catalog.json", import.meta.url);

const courseId = "_22_1";
const principalId = "_11_1";
const baseUrl = "https://blackboard.example.invalid";

function tenant(): BlackboardTenant {
  return {
    id: "fixture",
    baseUrl,
    applicationKey: "app-key",
    clientSecret: "client-secret",
    principalId,
    courseBindings: [{ sourceBindingId: deriveBlackboardSourceBindingId(baseUrl, principalId, courseId), courseId }],
  };
}

/** The tool names one MCP client sees. No Blackboard request is sent to list them. */
async function servedToolNames(includePrivateDispatch: boolean): Promise<readonly string[]> {
  const runtime = new BlackboardLearnRuntime([tenant()]);
  const client = new Client({ name: "blackboard-registry", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  const [left, right] = InMemoryTransport.createLinkedPair();
  const running = serveStdio(() => createBlackboardLearnMcpServer(runtime, { includePrivateDispatch }), { transport: right });
  await client.connect(left);
  const tools = await client.listTools();
  await client.close();
  await running.close();
  return tools.tools.map((tool) => tool.name);
}

/**
 * The Blackboard names in `PRIVATE_SOURCE_TOOL_NAMES`, read from the Gateway
 * source itself. A parse that finds nothing fails here instead of reporting an
 * empty list as agreement.
 */
async function gatewayPrivateBlackboardNames(): Promise<readonly string[]> {
  const source = await readFile(GATEWAY_RUNTIME, "utf8");
  const block = /export const PRIVATE_SOURCE_TOOL_NAMES[^=]*=\s*new Set\(\[([^\]]*)\]\)/.exec(source);
  if (!block || !block[1]) {
    throw new Error("packages/mcp-server/src/runtime.ts no longer declares PRIVATE_SOURCE_TOOL_NAMES as one literal set. Read it and update this test.");
  }
  const names = [...block[1].matchAll(/"([A-Za-z0-9_]+)"/g)].map((match) => match[1]);
  if (names.length === 0) throw new Error("PRIVATE_SOURCE_TOOL_NAMES holds no tool name that this test could read.");
  return names.filter((name) => name?.startsWith("blackboard_")) as readonly string[];
}

describe("blackboard operation registry", () => {
  it("serves every registered tool, and the dispatch routes only to the Gateway", async () => {
    const registered = BLACKBOARD_TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(await servedToolNames(true)).toEqual(registered);
    expect(await servedToolNames(false)).toEqual(
      BLACKBOARD_TOOL_DEFINITIONS.filter((tool) => !tool.gatewayDispatchOnly).map((tool) => tool.name),
    );
    expect(BLACKBOARD_TOOL_DEFINITIONS.filter((tool) => tool.gatewayDispatchOnly).map((tool) => tool.name)).toEqual([
      "blackboard_apply_reviewed_membership_patch",
      "blackboard_verify_membership_patch",
      "blackboard_apply_reviewed_gradebook_column_patch",
      "blackboard_verify_gradebook_column_patch",
      "blackboard_apply_reviewed_gradebook_grade_patch",
      "blackboard_verify_gradebook_grade_patch",
      "blackboard_apply_reviewed_content_attachment",
      "blackboard_verify_content_attachment",
      "blackboard_apply_reviewed_ultra_assignment",
      "blackboard_verify_ultra_assignment",
      "blackboard_apply_reviewed_course_announcement",
      "blackboard_verify_course_announcement",
      "blackboard_apply_reviewed_course_announcement_patch",
      "blackboard_verify_course_announcement_patch",
      "blackboard_apply_reviewed_course_group",
      "blackboard_verify_course_group",
      "blackboard_apply_reviewed_course_group_patch",
      "blackboard_verify_course_group_patch",
      "blackboard_apply_reviewed_group_membership",
      "blackboard_verify_group_membership",
      "blackboard_apply_reviewed_group_membership_removal",
      "blackboard_verify_group_membership_removal",
      "blackboard_apply_reviewed_course_availability",
      "blackboard_verify_course_availability",
      "blackboard_apply_reviewed_content_dated_visibility",
      "blackboard_verify_content_dated_visibility",
      "blackboard_apply_reviewed_course_copy",
      "blackboard_verify_course_copy",
      "blackboard_apply_reviewed_content_patch",
      "blackboard_verify_content_patch",
    ]);
  });

  it("gives every tool a unique name, a capability block, and an entitlement", () => {
    const names = BLACKBOARD_TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(BLACKBOARD_OPERATION_MODULES.map((module) => module.id)).toEqual(["health", "course-read", "course-contents", "memberships", "gradebook", "files", "assignments", "announcements", "groups", "course-lifecycle", "content-patch", "effect-receipts"]);
    for (const tool of BLACKBOARD_TOOL_DEFINITIONS) {
      expect(["unknown", "none"]).toContain(tool.rest.entitlement);
      if (tool.rest.method === null) {
        expect(["morrow_blackboard_health", "blackboard_unresolved_effects"]).toContain(tool.name);
        expect(tool.rest.entitlement).toBe("none");
        expect(tool.capability).toBeNull();
        continue;
      }
      expect(tool.capability?.provider).toBe("blackboard");
      expect(tool.capability?.family).toBeTruthy();
      expect(tool.capability?.evidence?.live).toEqual({ state: "unknown", reason: "api_configured_live_untested" });
      // No tenant Swagger has been read, so no route states a settled entitlement.
      expect(tool.rest.entitlement).toBe("unknown");
      expect(tool.rest.pathTemplate?.startsWith("/learn/api/public/")).toBe(true);
    }
  });

  it("marks private exactly the Blackboard names the Gateway keeps out of its catalog", async () => {
    const registryPrivate = BLACKBOARD_TOOL_DEFINITIONS.filter((tool) => tool.private).map((tool) => tool.name);
    expect([...registryPrivate].sort()).toEqual([...await gatewayPrivateBlackboardNames()].sort());
    expect(registryPrivate).toHaveLength(45);
  });

  it("names a review route and a readback comparator for every write", () => {
    const catalog = blackboardRestCatalog();
    const rows = catalog.tools as readonly Record<string, unknown>[];
    expect(rows.map((row) => row.tool)).toEqual(BLACKBOARD_TOOL_DEFINITIONS.map((tool) => tool.name));
    const names = new Set(rows.map((row) => row.tool));
    for (const row of rows) {
      expect(row.provider).toBe("blackboard");
      if (row.access === "write") {
        expect(names.has(row.reviewRoute)).toBe(true);
        expect(names.has(row.readbackComparator)).toBe(true);
        continue;
      }
      // A read sends no change, so it has nothing to review and nothing to compare.
      expect(row.reviewRoute).toBeNull();
      expect(row.readbackComparator).toBeNull();
    }
    expect(catalog.counts).toMatchObject({ tools: rows.length, writes: 15 });
  });

  it("keeps the generated catalog artifact current", async () => {
    const written = await readFile(CATALOG_ARTIFACT, "utf8").catch(() => "");
    if (!written) throw new Error("artifacts/blackboard/blackboard-rest-catalog.json is missing. Run node scripts/blackboard-catalog.mjs.");
    expect(written).toBe(JSON.stringify(blackboardRestCatalog(), null, 2) + "\n");
  });
});
