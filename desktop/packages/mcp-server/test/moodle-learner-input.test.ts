import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import {
  MOODLE_ENROL_CANDIDATE_INPUT_TOOL,
  MOODLE_ROSTER_LEARNER_INPUT_TOOLS,
  assertPublicMoodleLearnerInput,
  publicMoodleLearnerInputSchema,
  isMoodleLearnerToken,
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
  it("replaces every private learner id with the exact readable public label", () => {
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
        .toThrow(/readable learner label/);
    }
    expect(() => assertPublicMoodleLearnerInput(MOODLE_ENROL_CANDIDATE_INPUT_TOOL, {
      course_id: 2,
      user_id: 7,
    })).toThrow(/readable learner label/);
  });

  it("allows a scoped learner label, a candidate label, or a group-only override", () => {
    assertPublicMoodleLearnerInput("moodle_get_assignment_submission", {
      course_id: 2,
      learner_token: "Student A1",
    });
    assertPublicMoodleLearnerInput(MOODLE_ENROL_CANDIDATE_INPUT_TOOL, {
      course_id: 2,
      candidate_token: "Student A1",
    });
    assertPublicMoodleLearnerInput("moodle_create_assignment_override", {
      course_id: 2,
      group_id: 3,
    });
    expect(() => assertPublicMoodleLearnerInput("moodle_create_assignment_override", {
      course_id: 2,
      group_id: 3,
      learner_token: "Student A2",
    })).toThrow(/one learner or one group/);
  });

  it("accepts the public label grammar and refuses internal or ambiguous references", () => {
    for (const label of ["Student A1", "Student A2", "Student A1000"]) {
      expect(isMoodleLearnerToken(label)).toBe(true);
      for (const name of MOODLE_ROSTER_LEARNER_INPUT_TOOLS) {
        const schema = properties(publicMoodleLearnerInputSchema(name, operation(name).inputSchema)).learner_token as JsonObject;
        expect(new RegExp(String(schema.pattern)).test(label), name).toBe(true);
        expect(() => assertPublicMoodleLearnerInput(name, { learner_token: label })).not.toThrow();
      }
    }
    for (const label of ["Student A0", "Student A01", "Student A1 ", "student A1", "Student A1 or Student A2", "Jane Doe", "learner_2f1a5b3c-9d4e-4f6a-8b7c-1d2e3f4a5b6c"]) {
      expect(isMoodleLearnerToken(label), label).toBe(false);
      expect(() => assertPublicMoodleLearnerInput("moodle_get_assignment_submission", { learner_token: label })).toThrow();
    }
    expect(() => assertPublicMoodleLearnerInput(MOODLE_ENROL_CANDIDATE_INPUT_TOOL, { candidate_token: "Student A1", learner_token: "Student A2" })).toThrow();
  });

});
