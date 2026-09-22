import { describe, expect, it } from "vitest";
import type { EffectOperationRecord } from "@morrow/operation-journal";
import { moodleActivityCreateRecoveryDescriptor, moodleSectionMoveRecoveryDescriptor } from "../src/runtime.js";

describe("Moodle unresolved activity creation recovery", () => {
  it("derives an exact course-content read from the frozen create request", () => {
    const descriptor = moodleActivityCreateRecoveryDescriptor({
      sourceToolName: "moodle_create_quiz",
      forwardedRequest: {
        course_id: 2,
        section_id: 1,
        name: "MORROWPROOF quiz",
        instructions: "<p>Proof</p>",
        expected_digest: "a".repeat(64),
      },
    } as EffectOperationRecord);

    expect(descriptor).toEqual({
      schema: "morrow.canvas-recovery-descriptor.v1",
      strategy: "collection-contains-target",
      writeMethod: "POST",
      assertions: [{ inputName: "module", paths: [["module"]], expected: "quiz" }],
      read: {
        readTool: "moodle_get_contents",
        arguments: { course_id: 2 },
        targetId: "MORROWPROOF quiz",
        targetField: "name",
        targetPath: ["activities"],
      },
    });
  });

  it("does not invent recovery for a non-create operation or invalid request", () => {
    expect(moodleActivityCreateRecoveryDescriptor({
      sourceToolName: "moodle_update_quiz",
      forwardedRequest: { course_id: 2, name: "Quiz" },
    } as EffectOperationRecord)).toBeNull();
    expect(moodleActivityCreateRecoveryDescriptor({
      sourceToolName: "moodle_create_quiz",
      forwardedRequest: { course_id: 2, name: "" },
    } as EffectOperationRecord)).toBeNull();
    expect(moodleActivityCreateRecoveryDescriptor({
      sourceToolName: "moodle_create_quiz",
      forwardedRequest: { course_id: "9007199254740992", name: "Quiz" },
    } as EffectOperationRecord)).toBeNull();
  });
});

describe("Moodle unresolved section move recovery", () => {
  it("derives an exact course-section position read from the frozen move request", () => {
    const descriptor = moodleSectionMoveRecoveryDescriptor({
      sourceToolName: "moodle_move_section",
      forwardedRequest: {
        course_id: 3,
        section_id: 25,
        position: 1,
        expected_digest: "a".repeat(64),
      },
    } as EffectOperationRecord);

    expect(descriptor).toEqual({
      schema: "morrow.canvas-recovery-descriptor.v1",
      strategy: "updated-resource",
      writeMethod: "POST",
      assertions: [{ inputName: "position", paths: [["section"]], expected: 1 }],
      read: {
        readTool: "moodle_get_contents",
        arguments: { course_id: 3 },
        targetId: "25",
        targetField: "id",
        targetPath: ["sections"],
      },
    });
  });

  it("does not invent section-move recovery for another operation or invalid identity", () => {
    expect(moodleSectionMoveRecoveryDescriptor({
      sourceToolName: "moodle_show_section",
      forwardedRequest: { course_id: 3, section_id: 25, position: 1 },
    } as EffectOperationRecord)).toBeNull();
    expect(moodleSectionMoveRecoveryDescriptor({
      sourceToolName: "moodle_move_section",
      forwardedRequest: { course_id: 3, section_id: 25, position: 0 },
    } as EffectOperationRecord)).toBeNull();
    expect(moodleSectionMoveRecoveryDescriptor({
      sourceToolName: "moodle_move_section",
      forwardedRequest: { course_id: 3, section_id: "9007199254740992", position: 1 },
    } as EffectOperationRecord)).toBeNull();
  });
});
