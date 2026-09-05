import { describe, expect, it } from "vitest";
import { canvasCatalogTools, parseCanvasApiCatalog, operationArguments } from "../src/index.js";
import catalogJson from "../../../artifacts/canvas-api/canvas-api-catalog.json";

const catalog = parseCanvasApiCatalog(catalogJson);

describe("Canvas API catalog", () => {
  it("covers the official surface plus the browser-session Item Banks contract", () => {
    expect(catalog.counts.officialOperations).toBeGreaterThanOrEqual(1_100);
    expect(catalog.counts.itemBankOperations).toBe(12);
    expect(catalog.counts.newQuizzesOperations).toBeGreaterThan(12);
    expect(new Set(catalog.operations.map((operation) => operation.toolName)).size).toBe(catalog.operations.length);
  });

  it("keeps Canvas int64 identifiers as exact decimal strings", () => {
    const operation = catalog.operations.find((candidate) => candidate.toolName === "canvas_get_new_quiz");
    expect(operation).toBeTruthy();
    const course = operation!.parameters.find((parameter) => parameter.wireName === "course_id");
    expect(course?.schema).toMatchObject({ type: "string", pattern: "^[1-9][0-9]*$" });
    expect(operationArguments(operation!, { course_id: "9007199254740993", assignment_id: "9223372036854775807" }).path)
      .toBe("/quiz/v1/courses/9007199254740993/quizzes/9223372036854775807");
  });

  it("accepts a Page module item with its page slug and no content ID", () => {
    const operation = catalog.operations.find((candidate) => candidate.toolName === "canvas_create_module_item");
    expect(operation).toBeTruthy();
    expect(operation!.inputSchema.required).not.toContain("module_item_content_id");
    expect(operation!.inputSchema.allOf).toContainEqual({
      if: { properties: { module_item_type: { const: "Page" } }, required: ["module_item_type"] },
      then: { required: ["module_item_page_url"] },
    });
    expect(operationArguments(operation!, {
      course_id: "1",
      module_id: "2",
      module_item_type: "Page",
      module_item_page_url: "cell-structures",
    }).body).toEqual([
      ["module_item[page_url]", "cell-structures"],
      ["module_item[type]", "Page"],
    ]);
  });

  it("still requires content ID for non-exempt module items", () => {
    const operation = catalog.operations.find((candidate) => candidate.toolName === "canvas_create_module_item");
    expect(operation).toBeTruthy();
    expect(() => operationArguments(operation!, {
      course_id: "1",
      module_id: "2",
      module_item_type: "Assignment",
    })).toThrow("module_item_content_id is required");
  });

  it("publishes official Canvas and Item Bank operations in the public Canvas profile", () => {
    const tools = canvasCatalogTools(catalog);
    expect(tools).toHaveLength(catalog.counts.totalOperations);
    const held = tools.filter((tool) => tool.capability?.profiles["public-canvas"].state !== "supported");
    expect(held).toHaveLength(6);
    expect(held.every((tool) => tool.capability?.family === "new-quizzes-item-banks" && tool.annotations?.readOnlyHint === false)).toBe(true);
    expect(tools.filter((tool) => tool.capability?.family === "new-quizzes-item-banks")).toHaveLength(12);
  });
});
