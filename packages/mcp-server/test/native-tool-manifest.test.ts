import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mergeCatalog } from "@morrow/gateway-core";
import { BLACKBOARD_ACTIONS } from "../src/blackboard-actions.js";
import { BLACKBOARD_CONTENT_PATCH_PLAN_NATIVE_TOOL } from "../src/blackboard-content-patch.js";
import { PUBLIC_MOODLE_ENROLMENT_CANDIDATE_TOOL } from "../src/moodle-learner-input.js";
import { MOODLE_STAGED_FILE_CAPABILITIES } from "../src/moodle-resource-file.js";
import {
  MORROW_NATIVE_EXCLUDED_NAMES,
  MORROW_NATIVE_TOOL_NAMES,
  NATIVE_TOOL_MANIFEST,
} from "../src/native-tool-manifest.js";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "../src");
const compactFiles = [
  "activity-tools.ts", "canvas-file-transfer.ts", "course-audit.ts", "course-inventory.ts",
  "edit-access.ts", "lesson-review.ts", "private-chat.ts", "program-ledger.ts", "server.ts",
];
const fullFiles = [
  "batch-tools.ts", "blackboard-actions.ts", "blackboard-content-patch.ts", "canvas-conversations.ts",
  "item-bank-fan-out.ts", "item-bank-repair.ts", "new-quiz-effects.ts", "new-quiz-item-lifecycle.ts",
  "new-quiz-item-order.ts", "new-quiz-lifecycle.ts", "new-quiz-settings.ts", "operation-tools.ts",
  "page-correction.ts", "quiz-check.ts",
];

function literalRegistrations(files: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const file of files) {
    const source = readFileSync(join(sourceRoot, file), "utf8");
    for (const match of source.matchAll(/registerTool\(\s*["']([^"']+)["']/g)) names.add(match[1]!);
  }
  return names;
}

function registeredNativeNames(): { compact: Set<string>; full: Set<string> } {
  const compact = literalRegistrations(compactFiles);
  compact.add("morrow_capability_read");
  compact.add("morrow_capability_change");
  compact.add(PUBLIC_MOODLE_ENROLMENT_CANDIDATE_TOOL);
  for (const capability of Object.values(MOODLE_STAGED_FILE_CAPABILITIES)) compact.add(capability.publicPlanToolName);

  const fullOnly = literalRegistrations(fullFiles);
  fullOnly.add(BLACKBOARD_CONTENT_PATCH_PLAN_NATIVE_TOOL);
  for (const action of BLACKBOARD_ACTIONS) fullOnly.add(action.publicName);
  const all = new Set([...compact, ...fullOnly]);
  return { compact: all, full: all };
}

describe("native tool manifest", () => {
  it("is exactly equal to every compact and full native registration", () => {
    const registered = registeredNativeNames();
    const compactManifest = NATIVE_TOOL_MANIFEST.filter((entry) => entry.surfaces.includes("compact")).map((entry) => entry.name).sort();
    const fullManifest = NATIVE_TOOL_MANIFEST.filter((entry) => entry.surfaces.includes("full")).map((entry) => entry.name).sort();
    expect(compactManifest).toEqual([...registered.compact].sort());
    expect(fullManifest).toEqual([...registered.full].sort());
    expect(MORROW_NATIVE_TOOL_NAMES).toEqual([...registered.full].sort());
    expect(new Set(MORROW_NATIVE_TOOL_NAMES).size).toBe(MORROW_NATIVE_TOOL_NAMES.length);
  });

  it("reserves or excludes every native name before catalog merge", () => {
    const emptySchema = { type: "object", properties: {} };
    const catalog = mergeCatalog([{
      id: "collision-source",
      label: "Collision source",
      priority: 1,
      tools: MORROW_NATIVE_TOOL_NAMES.map((name) => ({ name, inputSchema: emptySchema })),
    }], {
      reservedNames: MORROW_NATIVE_TOOL_NAMES,
      excludeNames: MORROW_NATIVE_EXCLUDED_NAMES,
      generatedAt: "2026-09-12T00:00:00.000Z",
    });
    const nativePublicNames = new Set(catalog.tools.map((tool) => tool.publicName));
    for (const descriptor of NATIVE_TOOL_MANIFEST) {
      expect(nativePublicNames.has(descriptor.name), descriptor.name).toBe(false);
      if (descriptor.collisionPolicy === "exclude") {
        expect(catalog.excluded).toContainEqual({ upstreamId: "collision-source", upstreamName: descriptor.name, reason: "excluded_name" });
      } else {
        expect(catalog.collisions.some((collision) => collision.requestedName === descriptor.name && collision.retainedBy === "morrow"), descriptor.name).toBe(true);
      }
    }
  });
});
