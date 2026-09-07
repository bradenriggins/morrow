import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  loadMoodleBrowserCatalog,
  parseMoodleBrowserCatalog,
  MOODLE_BROWSER_CATALOG_PATH,
  type MoodleBrowserCatalog,
} from "../../canvas-connector-mcp/src/browser-catalog.js";
import { isPrivateSourceTool, PRIVATE_SOURCE_TOOL_NAMES } from "../src/runtime.js";

const DIGEST = "a".repeat(64);
const ROSTER_TOOL = "moodle_get_course_participant_roster";
const catalog = loadMoodleBrowserCatalog();

// The Gateway list is what hides a tool. This is the Moodle part of it.
const gatewayPrivateTools = [...PRIVATE_SOURCE_TOOL_NAMES].filter((name) => name.startsWith("moodle_")).sort();

function catalogPrivateTools(value: MoodleBrowserCatalog): string[] {
  return value.operations.filter((operation) => operation.morrowPrivate === true).map((operation) => operation.toolName).sort();
}

/**
 * Re-parses the shipped catalog with the marker on the named tools changed, so
 * the checks below run against a catalog that disagrees with the Gateway list.
 * `undefined` removes the marker.
 */
function catalogWithMarkers(markers: Readonly<Record<string, unknown>>): MoodleBrowserCatalog {
  const raw = JSON.parse(readFileSync(MOODLE_BROWSER_CATALOG_PATH, "utf8")) as {
    readonly operations: readonly Record<string, unknown>[];
  };
  const operations = raw.operations.map((entry) => {
    const toolName = String(entry.toolName);
    if (!Object.hasOwn(markers, toolName)) return entry;
    const changed = { ...entry };
    delete changed.morrowPrivate;
    return markers[toolName] === undefined ? changed : { ...changed, morrowPrivate: markers[toolName] };
  });
  return parseMoodleBrowserCatalog({ ...raw, operations }, DIGEST);
}

describe("Moodle private-tool markers", () => {
  it("marks the same Moodle tools the Gateway keeps out of the public catalog", () => {
    expect(gatewayPrivateTools).toEqual([ROSTER_TOOL]);
    expect(catalogPrivateTools(catalog)).toEqual(gatewayPrivateTools);
    expect(catalog.operations.filter((operation) => operation.toolName === ROSTER_TOOL)).toHaveLength(1);
    for (const operation of catalog.operations) {
      expect(operation.morrowPrivate === true, operation.toolName)
        .toBe(isPrivateSourceTool({ upstreamName: operation.toolName }));
    }
  });

  it("reports a Gateway-private Moodle tool whose catalog entry lost the marker", () => {
    const without = catalogWithMarkers({ [ROSTER_TOOL]: undefined });
    expect(without.operations.some((operation) => operation.toolName === ROSTER_TOOL)).toBe(true);
    expect(catalogPrivateTools(without)).toEqual([]);
    expect(catalogPrivateTools(without)).not.toEqual(gatewayPrivateTools);
  });

  it("reports a catalog entry marked private that the Gateway still publishes", () => {
    const extra = catalogWithMarkers({ moodle_get_page: true });
    expect(catalogPrivateTools(extra)).toEqual([ROSTER_TOOL, "moodle_get_page"]);
    expect(isPrivateSourceTool({ upstreamName: "moodle_get_page" })).toBe(false);
    expect(catalogPrivateTools(extra)).not.toEqual(gatewayPrivateTools);
  });

  it("refuses a marker that is not a boolean", () => {
    expect(() => catalogWithMarkers({ [ROSTER_TOOL]: "true" }))
      .toThrow("Moodle browser catalog morrowPrivate is invalid");
    expect(catalogWithMarkers({ [ROSTER_TOOL]: false }).operations.find((operation) => operation.toolName === ROSTER_TOOL))
      .not.toHaveProperty("morrowPrivate");
  });
});
