import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { augmentBridgeInputSchema } from "@morrow/bridge-protocol";
import type { UpstreamTool } from "@morrow/contracts";
import { MAX_PUBLIC_CATALOG_BYTES } from "@morrow/canvas-api-catalog";
import {
  CANVAS_BROWSER_CATALOG_PATH,
  MOODLE_BROWSER_CATALOG_PATH,
  browserCatalogCompatibilityDigest,
  canvasBrowserCatalogTools,
  loadCanvasBrowserCatalog,
  loadMoodleBrowserCatalog,
  MAX_MOODLE_JSON_INTEGER,
  moodleCatalogTools,
  parseMoodleBrowserCatalog,
} from "../src/browser-catalog.js";

const digest = "a".repeat(64);
const temporaryDirectories: string[] = [];

const moodleTools = new Map(moodleCatalogTools(loadMoodleBrowserCatalog()).map((tool) => [tool.name, tool]));
const canvasTools = new Map(canvasBrowserCatalogTools(loadCanvasBrowserCatalog()).map((tool) => [tool.name, tool]));

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryPath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), "morrow-browser-catalog-"));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

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
  it("loads ordinary Canvas and Moodle catalogs without changing their raw-byte digests", () => {
    const canvasBytes = readFileSync(CANVAS_BROWSER_CATALOG_PATH);
    const moodleBytes = readFileSync(MOODLE_BROWSER_CATALOG_PATH);
    expect(loadCanvasBrowserCatalog().rawDigest).toBe(createHash("sha256").update(canvasBytes).digest("hex"));
    expect(loadMoodleBrowserCatalog().rawDigest).toBe(createHash("sha256").update(moodleBytes).digest("hex"));
  });

  it("keeps presentation edits out of browser operational compatibility", () => {
    const first = parseMoodleBrowserCatalog(moodleCatalog({
      inputSchema: {
        type: "object",
        properties: { description: { type: "string", description: "Original field help." } },
        additionalProperties: false,
      },
    }), "a".repeat(64));
    const presentation = parseMoodleBrowserCatalog(moodleCatalog({
      summary: "New visible title",
      description: "New visible explanation.",
      documentation: "https://example.invalid/new-docs",
      inputSchema: {
        type: "object",
        description: "New schema help.",
        properties: { description: { type: "string", description: "New field help." } },
        additionalProperties: false,
      },
    }), "b".repeat(64));
    expect(presentation.rawDigest).not.toBe(first.rawDigest);
    expect(browserCatalogCompatibilityDigest(presentation)).toBe(browserCatalogCompatibilityDigest(first));
    expect(presentation.compatibilityDigest).toBe(first.compatibilityDigest);

    const changedKey = parseMoodleBrowserCatalog(moodleCatalog({ key: "moodle.form.test.changed.read.v1" }), "c".repeat(64));
    expect(changedKey.compatibilityDigest).not.toBe(first.compatibilityDigest);
  });

  it("refuses an oversized sparse browser catalog before allocating or parsing it", () => {
    const path = temporaryPath("oversized-catalog.json");
    writeFileSync(path, "{");
    truncateSync(path, MAX_PUBLIC_CATALOG_BYTES + 1);
    expect(() => loadCanvasBrowserCatalog(path)).toThrow(/16 MiB/u);
  });

  it.skipIf(process.platform === "win32")("refuses a browser-catalog FIFO without waiting for a writer", () => {
    const path = temporaryPath("catalog.pipe");
    expect(spawnSync("mkfifo", [path]).status).toBe(0);
    const startedAt = Date.now();
    expect(() => loadMoodleBrowserCatalog(path)).toThrow(/stable regular file/u);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("refuses invalid UTF-8 before browser catalog JSON parsing", () => {
    const path = temporaryPath("invalid-utf8.json");
    writeFileSync(path, Buffer.from([0x7b, 0xc3, 0x28, 0x7d]));
    expect(() => loadCanvasBrowserCatalog(path)).toThrow(/strict UTF-8/u);
  });

  it("gives the destructive approval class to the Moodle write that removes content", () => {
    const remove = tool("moodle_delete_book_chapter");
    expect(remove.capability?.authority?.approvalClass).toBe("destructive");
    expect(remove.annotations?.destructiveHint).toBe(true);
    expect(remove.capability?.behavior?.destructive).toBe(true);
    expect(remove.capability?.behavior?.irreversible).toBe(true);
    const replace = tool("moodle_replace_scorm_package");
    expect(replace.capability?.authority?.approvalClass).toBe("destructive");
    expect(replace.capability?.behavior?.irreversible).toBe(true);
    const replaceH5p = tool("moodle_replace_h5pactivity_package");
    expect(replaceH5p.capability?.authority?.approvalClass).toBe("destructive");
    expect(replaceH5p.capability?.behavior?.irreversible).toBe(true);
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
        "moodle_replace_h5pactivity_package",
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

  it("publishes one exact safe-integer boundary for representative Moodle identifiers", async () => {
    const cases: ReadonlyArray<{ name: string; field: string; arguments: Record<string, unknown> }> = [
      { name: "moodle_get_course", field: "course_id", arguments: { course_id: 42 } },
      {
        name: "moodle_update_page",
        field: "module_id",
        arguments: { course_id: 42, module_id: 7, name: "Exact page", expected_digest: "a".repeat(64) },
      },
      {
        name: "moodle_get_assignment_submission",
        field: "user_id",
        arguments: { course_id: 42, module_id: 7, user_id: 21 },
      },
      {
        name: "moodle_delete_section",
        field: "section_id",
        arguments: { course_id: 42, section_id: 8, expected_digest: "b".repeat(64) },
      },
    ];
    for (const example of cases) {
      const validate = fromJsonSchema(augmentBridgeInputSchema(tool(example.name).inputSchema, false, false))["~standard"].validate;
      expect((await validate({ ...example.arguments, [example.field]: MAX_MOODLE_JSON_INTEGER })).issues, example.name).toBeUndefined();
      expect((await validate({ ...example.arguments, [example.field]: MAX_MOODLE_JSON_INTEGER + 1 })).issues, example.name).toBeTruthy();
      expect((await validate({ ...example.arguments, [example.field]: String(MAX_MOODLE_JSON_INTEGER + 2) })).issues, example.name).toBeTruthy();
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
    expect(() => parseMoodleBrowserCatalog(moodleCatalog({ inputSchema: {
      type: "object",
      properties: { course_id: { type: "integer", minimum: 1 } },
      additionalProperties: false,
    } }), digest)).toThrow("Moodle browser catalog operation moodle_test_read has an unbounded or inexact integer schema");
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
