import { describe, expect, it } from "vitest";
import {
  expandEnvironmentTemplate,
  parseGatewayConfig,
} from "../src/config.js";

describe("gateway configuration", () => {
  it("expands required and fallback environment values", () => {
    expect(expandEnvironmentTemplate("${ONE}/${TWO:-fallback}", { ONE: "value" }))
      .toBe("value/fallback");
  });

  it("fails when a required environment value is missing", () => {
    expect(() => expandEnvironmentTemplate("${MISSING}", {}))
      .toThrow("Missing environment variable MISSING");
  });

  it("removes disabled upstreams, keeps publisher holds, and expands the journal path", () => {
    const parsed = parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      profile: "private-full",
      upstreams: [
        {
          id: "meridian",
          label: "Meridian",
          kind: "mcp-stdio",
          command: "python3",
          args: ["${SERVER}"],
          enabled: true,
        },
        {
          id: "disabled",
          label: "Disabled",
          kind: "mcp-stdio",
          command: "false",
          enabled: false,
        },
      ],
      operationJournal: { path: "${STATE_ROOT}/morrow.sqlite3" },
    }, { SERVER: "/tmp/server.py", STATE_ROOT: "/tmp/morrow-state" });

    expect(parsed.upstreams).toHaveLength(1);
    expect(parsed.filters.excludePrefixes).toEqual(["mindtap_", "connect_"]);
    expect(parsed.operationJournal.path).toBe("/tmp/morrow-state/morrow.sqlite3");
  });
});
