import { describe, expect, it } from "vitest";
import { composeCanvasCourseContentAndModule } from "../src/canvas-course-compose.js";

const base = {
  schema: "morrow.canvas-course-compose.v1" as const,
  courseId: "42",
  sourceBindingId: "canvas:school:42",
  content: { kind: "page" as const, childId: "page-create", arguments: { wiki_page_title: "Cell notes" } },
  placement: { childId: "page-place", moduleId: "9", title: "Cell notes", position: 2 },
};

describe("legacy Canvas content and module composition", () => {
  it("freezes a page create and an inert exact dependent module placement", () => {
    const plan = composeCanvasCourseContentAndModule(base);
    expect(plan.operations).toEqual([
      {
        childId: "page-create",
        courseId: "42",
        tool: "canvas_create_page_courses",
        sourceBindingId: "canvas:school:42",
        dependencyChildIds: [],
        arguments: {
          wiki_page_title: "Cell notes",
          course_id: "42",
          _morrow: { source_binding_id: "canvas:school:42" },
        },
      },
      {
        childId: "page-place",
        courseId: "42",
        tool: "canvas_create_module_item",
        sourceBindingId: "canvas:school:42",
        dependencyChildIds: ["page-create"],
        arguments: {
          course_id: "42",
          module_id: "9",
          module_item_type: "Page",
          module_item_title: "Cell notes",
          module_item_position: 2,
          _morrow: { source_binding_id: "canvas:school:42" },
        },
        resultBinding: {
          schema: "morrow.canvas-result-binding.v1",
          sourceChildId: "page-create",
          kind: "canvas_page_url_to_module_item_page_url",
        },
      },
    ]);
    expect(plan.operations[1]!.arguments).not.toHaveProperty("module_item_page_url");
  });

  it("freezes assignment placement with no caller-controlled assignment id", () => {
    const plan = composeCanvasCourseContentAndModule({
      ...base,
      content: { kind: "assignment", childId: "assignment-create", arguments: { assignment_name: "Reflect" } },
      placement: { childId: "assignment-place", moduleId: "9" },
    });
    expect(plan.operations[0]).toMatchObject({ tool: "canvas_create_assignment" });
    expect(plan.operations[1]).toMatchObject({
      tool: "canvas_create_module_item",
      arguments: { module_item_type: "Assignment" },
      resultBinding: {
        kind: "canvas_assignment_id_to_module_item_content_id",
        sourceChildId: "assignment-create",
      },
    });
    expect(plan.operations[1]!.arguments).not.toHaveProperty("module_item_content_id");
  });

  it("refuses forged binding controls, wrong course, duplicate child identity, and invalid placement", () => {
    expect(() => composeCanvasCourseContentAndModule({
      ...base,
      content: { ...base.content, arguments: { wiki_page_title: "Cell notes", course_id: "43" } },
    })).toThrow(/selected course/);
    expect(() => composeCanvasCourseContentAndModule({
      ...base,
      content: { ...base.content, arguments: { wiki_page_title: "Cell notes", _morrow: { source_binding_id: "canvas:other:42", operation_id: "forged" } } },
    })).toThrow(/source binding/);
    expect(() => composeCanvasCourseContentAndModule({
      ...base,
      placement: { ...base.placement, childId: "page-create" },
    })).toThrow(/must differ/);
    expect(() => composeCanvasCourseContentAndModule({
      ...base,
      placement: { ...base.placement, moduleId: "0" },
    })).toThrow(/module id/);
  });
});
