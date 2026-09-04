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

  it("publishes official Canvas and Item Bank operations in the public Canvas profile", () => {
    const tools = canvasCatalogTools(catalog);
    expect(tools).toHaveLength(catalog.counts.totalOperations);
    const held = tools.filter((tool) => tool.capability?.profiles["public-canvas"].state !== "supported");
    expect(held).toHaveLength(6);
    expect(held.every((tool) => tool.capability?.family === "new-quizzes-item-banks" && tool.annotations?.readOnlyHint === false)).toBe(true);
    expect(tools.filter((tool) => tool.capability?.family === "new-quizzes-item-banks")).toHaveLength(12);
  });
});
