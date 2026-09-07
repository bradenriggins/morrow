import { describe, expect, it } from "vitest";
import type { UpstreamTool } from "@morrow/contracts";
import {
  canvasBrowserCatalogTools,
  loadCanvasBrowserCatalog,
  loadMoodleBrowserCatalog,
  moodleCatalogTools,
  parseMoodleBrowserCatalog,
} from "../src/browser-catalog.js";

const digest = "a".repeat(64);

const moodleTools = new Map(moodleCatalogTools(loadMoodleBrowserCatalog()).map((tool) => [tool.name, tool]));
const canvasTools = new Map(canvasBrowserCatalogTools(loadCanvasBrowserCatalog()).map((tool) => [tool.name, tool]));

function tool(name: string): UpstreamTool {
  const found = moodleTools.get(name);
  if (!found) throw new Error(`${name} is not in the Moodle browser catalog`);
  return found;
}

const testRead = {
  key: "moodle.form.test.read.v1",
  toolName: "moodle_test_read",
  provider: "moodle",
  summary: "Read a test record",
  description: "Read one test record.",
  readOnly: true,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  documentation: "https://example.invalid/docs",
};

function moodleCatalog(...operations: Record<string, unknown>[]): unknown {
  return {
    schema: "morrow.browser-catalog.v1",
    provider: "moodle",
    operations: operations.map((operation) => ({ ...testRead, ...operation })),
  };
}

describe("browser catalog capability metadata", () => {
  it("gives the destructive approval class to the Moodle write that removes content", () => {
    const remove = tool("moodle_delete_book_chapter");
    expect(remove.capability?.authority?.approvalClass).toBe("destructive");
    expect(remove.annotations?.destructiveHint).toBe(true);
    expect(remove.capability?.behavior?.destructive).toBe(true);
    expect(remove.capability?.behavior?.irreversible).toBe(true);
    const replace = tool("moodle_replace_scorm_package");
    expect(replace.capability?.authority?.approvalClass).toBe("destructive");
    expect(replace.capability?.behavior?.irreversible).toBe(true);
    expect([...moodleTools.values()].filter((entry) => entry.annotations?.destructiveHint).map((entry) => entry.name).sort())
      .toEqual([
        "moodle_delete_activity",
        "moodle_delete_book_chapter",
        "moodle_delete_event",
        "moodle_delete_group",
        "moodle_delete_lesson_page",
        "moodle_delete_resource_file",
        "moodle_delete_section",
        "moodle_remove_quiz_slot",
        "moodle_replace_resource_file",
        "moodle_replace_scorm_package",
        "moodle_start_course_restore",
        "moodle_unenrol_participant",
      ]);
  });

  it("keeps ordinary Moodle writes at standard approval", () => {
    const update = tool("moodle_update_book_chapter");
    expect(update.capability?.authority?.approvalClass).toBe("standard");
    expect(update.annotations?.destructiveHint).toBe(false);
    expect(update.capability?.behavior?.destructive).toBe(false);
    expect(update.capability?.behavior?.irreversible).toBe(false);
  });

  it("labels the Moodle reads that carry learner data", () => {
    const learnerReads = [
      "moodle_get_forum_posts",
      "moodle_get_course_groups",
      "moodle_get_course_participant_roster",
      "moodle_get_assignment_submission_summary",
      "moodle_get_quiz_attempt_summary",
    ];
    for (const name of learnerReads) {
      const read = tool(name);
      expect(read.capability?.authority?.dataClass, name).toBe("learner");
      expect(read.capability?.family, name).toBe("learner-data");
      expect(read.capability?.authority?.approvalClass, name).toBe("none");
      expect(read.annotations?.destructiveHint, name).toBe(false);
    }
  });

  it("leaves Moodle course-content operations at the course data class", () => {
    for (const name of ["moodle_get_page", "moodle_update_page"]) {
      const entry = tool(name);
      expect(entry.capability?.authority?.dataClass, name).toBe("course");
      expect(entry.capability?.family, name).toBe("course-content");
    }
  });

  it("leaves Canvas browser-catalog entries at their existing values", () => {
    expect(canvasTools.size).toBeGreaterThan(0);
    for (const entry of canvasTools.values()) {
      const fileSignals = entry.name === "canvas_read_course_file_signals";
      expect(entry.capability?.authority?.dataClass, entry.name).toBe(fileSignals ? "course" : "learner");
      expect(entry.capability?.family, entry.name).toBe(fileSignals ? "files" : "assessment-summary");
      expect(entry.capability?.behavior?.destructive, entry.name).toBe(false);
      expect(entry.annotations?.destructiveHint, entry.name).toBe(false);
    }
  });

  it("refuses catalog metadata that would understate or mislabel an operation", () => {
    expect(() => parseMoodleBrowserCatalog(moodleCatalog({ destructive: true }), digest))
      .toThrow("Moodle browser catalog reads cannot be destructive or irreversible");
    expect(() => parseMoodleBrowserCatalog(moodleCatalog({ irreversible: true }), digest))
      .toThrow("Moodle browser catalog reads cannot be destructive or irreversible");
    expect(() => parseMoodleBrowserCatalog(moodleCatalog({ destructive: "true" }), digest))
      .toThrow("Moodle browser catalog destructive is invalid");
    expect(() => parseMoodleBrowserCatalog(moodleCatalog({ dataClass: "student" }), digest))
      .toThrow("Moodle browser catalog dataClass is invalid");
    expect(() => parseMoodleBrowserCatalog(moodleCatalog({ family: "" }), digest))
      .toThrow("Moodle browser catalog family is invalid");
  });

  it("carries a declared destructive write through the parser", () => {
    const catalog = parseMoodleBrowserCatalog(moodleCatalog({}, {
      key: "moodle.form.test.write.v1",
      toolName: "moodle_test_delete",
      summary: "Delete a test record",
      description: "Delete one test record.",
      readOnly: false,
      reviewTool: "moodle_test_read",
      destructive: true,
      irreversible: true,
    }), digest);
    expect(catalog.operations[1]).toMatchObject({ destructive: true, irreversible: true });
    const remove = moodleCatalogTools(catalog).find((entry) => entry.name === "moodle_test_delete");
    expect(remove?.capability?.authority?.approvalClass).toBe("destructive");
    expect(remove?.capability?.behavior?.irreversible).toBe(true);
    expect(remove?.annotations?.destructiveHint).toBe(true);
  });
});
