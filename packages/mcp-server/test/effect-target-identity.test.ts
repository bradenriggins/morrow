import { describe, expect, it } from "vitest";
import type { CatalogTool } from "@morrow/contracts";
import { stableEffectTargetIdentity, type EffectBindingScope, type EffectTargetProviderScope } from "../src/runtime.js";

const canvasSchool: EffectTargetProviderScope = {
  provider: "canvas",
  origin: "https://school.instructure.com",
};

function canvasTool(name: string, operationKey: string, upstreamId = "canvas-session"): CatalogTool {
  return {
    publicName: name,
    upstreamId,
    upstreamLabel: "Canvas",
    upstreamName: name,
    inputSchema: {},
    capability: {
      provider: "canvas",
      route: { backend: "canvas-connector" },
      sourceImplementations: [{ toolName: name, sourceExport: operationKey }],
    },
  } as unknown as CatalogTool;
}

function target(
  mapping: CatalogTool,
  request: Record<string, unknown>,
  scope: EffectTargetProviderScope = canvasSchool,
  legacyTargetNamespace?: string,
): string {
  return stableEffectTargetIdentity(mapping, request, undefined, scope, legacyTargetNamespace);
}

describe("stable effect target identity", () => {
  it("locks one Canvas object across verbs without serializing sibling objects", () => {
    const update = canvasTool(
      "canvas_edit_assignment",
      "PUT /v1/courses/{course_id}/assignments/{id}#edit_assignment",
    );
    const remove = canvasTool(
      "canvas_delete_assignment",
      "DELETE /v1/courses/{course_id}/assignments/{id}#delete_assignment",
    );
    expect(target(update, { course_id: "42", id: "7" }))
      .toBe(target(remove, { course_id: "42", id: "7" }));
    expect(target(update, { course_id: "42", id: "7" }))
      .not.toBe(target(remove, { course_id: "42", id: "8" }));
  });

  it("uses the known parent object for creates and the course object for favorites", () => {
    const createItem = canvasTool(
      "canvas_create_quiz_item",
      "POST /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items#create_quiz_item",
    );
    const addFavorite = canvasTool(
      "canvas_add_course_to_favorites",
      "POST /v1/users/self/favorites/courses/{id}#add_course_to_favorites",
    );
    const removeFavorite = canvasTool(
      "canvas_remove_course_from_favorites",
      "DELETE /v1/users/self/favorites/courses/{id}#remove_course_from_favorites",
    );
    expect(target(createItem, { course_id: "42", assignment_id: "7" }))
      .not.toBe(target(createItem, { course_id: "42", assignment_id: "8" }));
    expect(target(addFavorite, { id: "42" }))
      .toBe(target(removeFavorite, { id: "42" }));
  });

  it("locks a live object across connector sources and principals, while separating sites and providers", () => {
    const canvasModule = canvasTool(
      "canvas_update_module",
      "PUT /v1/courses/{course_id}/modules/{module_id}#update_module",
    );
    const otherCanvasConnector = canvasTool(
      "canvas_update_module",
      "PUT /v1/courses/{course_id}/modules/{module_id}#update_module",
      "canvas-session-other",
    );
    const moodlePage = {
      ...canvasTool("moodle_update_page", "moodle.form.course.modedit.page.write.v1"),
      capability: {
        provider: "moodle",
        route: { backend: "canvas-connector" },
        sourceImplementations: [{ toolName: "moodle_update_page", sourceExport: "moodle.form.course.modedit.page.write.v1" }],
      },
    } as unknown as CatalogTool;
    const secondCanvasSite: EffectTargetProviderScope = {
      provider: "canvas",
      origin: "https://other.instructure.com",
    };
    const moodleSite: EffectTargetProviderScope = {
      provider: "moodle",
      origin: "https://school.instructure.com",
      siteUrl: "https://school.instructure.com/moodle",
    };
    const request = { course_id: "42", module_id: "7" };
    const firstPrincipal: EffectBindingScope = {
      ...canvasSchool,
      sourceBindingId: "canvas:principal-a:42",
      principalFingerprint: "a".repeat(64),
      sessionGeneration: 1,
    };
    const secondPrincipal: EffectBindingScope = {
      ...canvasSchool,
      sourceBindingId: "canvas:principal-b:42",
      principalFingerprint: "b".repeat(64),
      sessionGeneration: 2,
    };

    expect(target(canvasModule, request, firstPrincipal))
      .toBe(target(otherCanvasConnector, request, secondPrincipal));
    expect(target(canvasModule, request, firstPrincipal))
      .not.toBe(target(canvasModule, request, secondCanvasSite));
    expect(target(canvasModule, request, firstPrincipal))
      .not.toBe(target(moodlePage, request, moodleSite));
  });

  it("keeps legacy nonbrowser target namespaces isolated by source and principal", () => {
    const legacy = {
      ...canvasTool("legacy_update", "PUT /v1/courses/{course_id}/pages/{url_or_id}#update_create_page_courses"),
      capability: {
        provider: "canvas",
        sourceImplementations: [{ toolName: "legacy_update", sourceExport: "PUT /v1/courses/{course_id}/pages/{url_or_id}#update_create_page_courses" }],
      },
    } as unknown as CatalogTool;
    const request = { course_id: "42", url_or_id: "welcome" };

    expect(target(legacy, request, canvasSchool, "legacy:source-a:principal-a"))
      .not.toBe(target(legacy, request, canvasSchool, "legacy:source-b:principal-b"));
  });
});
