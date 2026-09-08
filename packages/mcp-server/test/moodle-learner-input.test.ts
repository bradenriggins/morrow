import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import {
  MOODLE_ENROL_CANDIDATE_INPUT_TOOL,
  MOODLE_ROSTER_LEARNER_INPUT_TOOLS,
  assertPublicMoodleLearnerInput,
  publicMoodleLearnerInputSchema,
} from "../src/moodle-learner-input.js";

type MoodleCatalogEntry = Readonly<{ toolName: string; inputSchema: JsonObject }>;

const catalog = JSON.parse(readFileSync(
  resolve("../../connector/extension/generated/moodle-browser-catalog.json"),
  "utf8",
)) as { operations: MoodleCatalogEntry[] };

function operation(name: string): MoodleCatalogEntry {
  const found = catalog.operations.find((entry) => entry.toolName === name);
  if (!found) throw new Error(`Moodle operation ${name} is missing`);
  return found;
}

function properties(schema: JsonObject): JsonObject {
  return schema.properties as JsonObject;
}

describe("public Moodle learner inputs", () => {
  it("replaces every private learner id with the exact opaque public token", () => {
    for (const name of MOODLE_ROSTER_LEARNER_INPUT_TOOLS) {
      const schema = publicMoodleLearnerInputSchema(name, operation(name).inputSchema);
      expect(properties(schema), name).not.toHaveProperty("user_id");
      expect(properties(schema), name).toHaveProperty("learner_token");
      expect(JSON.stringify(schema), name).not.toContain('"user_id"');
    }
    const enrol = publicMoodleLearnerInputSchema(
      MOODLE_ENROL_CANDIDATE_INPUT_TOOL,
      operation(MOODLE_ENROL_CANDIDATE_INPUT_TOOL).inputSchema,
    );
    expect(properties(enrol)).not.toHaveProperty("user_id");
    expect(properties(enrol)).toHaveProperty("candidate_token");
    expect(enrol.required).toContain("candidate_token");
  });

  it("holds raw ids before reads, plans, or batch execution can reach a source", () => {
    for (const name of MOODLE_ROSTER_LEARNER_INPUT_TOOLS) {
      expect(() => assertPublicMoodleLearnerInput(name, { course_id: 2, user_id: 7 }), name)
        .toThrow(/opaque token/);
    }
    expect(() => assertPublicMoodleLearnerInput(MOODLE_ENROL_CANDIDATE_INPUT_TOOL, {
      course_id: 2,
      user_id: 7,
    })).toThrow(/opaque token/);
  });

  it("allows a scoped learner token, a candidate token, or a group-only override", () => {
    assertPublicMoodleLearnerInput("moodle_get_assignment_submission", {
      course_id: 2,
      learner_token: "learner_exact-course-token",
    });
    assertPublicMoodleLearnerInput(MOODLE_ENROL_CANDIDATE_INPUT_TOOL, {
      course_id: 2,
      candidate_token: "learner_exact-candidate-token",
    });
    assertPublicMoodleLearnerInput("moodle_create_assignment_override", {
      course_id: 2,
      group_id: 3,
    });
    expect(() => assertPublicMoodleLearnerInput("moodle_create_assignment_override", {
      course_id: 2,
      group_id: 3,
      learner_token: "learner_second-target",
    })).toThrow(/one learner or one group/);
  });
});
