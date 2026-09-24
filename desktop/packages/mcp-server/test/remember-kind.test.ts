import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isJsonObject, sha256Text, type JsonObject } from "@morrow/contracts";
import { parseGatewayConfig } from "../src/config.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";
import { EditCategoryUnavailableError, REMEMBERABLE_EDIT_CATEGORIES, type GatewayRuntime } from "../src/runtime.js";
import { planPageImageAltRepair } from "../src/page-correction.js";
import { planNewQuizSettings } from "../src/new-quiz-settings.js";
import { bridgeCatalogDigestForTests } from "./fixtures/bridge-catalog-digest.js";
import { connectBridgeTestClient, type BridgeTestClient } from "./fixtures/bridge-client.js";
import { assertPortListening, reserveLoopbackPort } from "./fixtures/loopback-port.js";

/** Mirrors canvas-connector.integration.test.ts: one connector, one course, cases share it. */
const CASE_TIMEOUT_MS = 30_000;

function operationId(result: JsonObject): string {
  const value = isJsonObject(result.structuredContent) ? result.structuredContent.operationId : undefined;
  if (typeof value !== "string") throw new Error("operation id missing");
  return value;
}

function connectorConfig(directory: string, port: number) {
  const root = resolve("../..");
  const catalogPath = resolve(root, "artifacts/canvas-api/canvas-api-catalog.json");
  return parseGatewayConfig({
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    upstreams: [{
      id: "canvas-session",
      label: "Morrow Canvas Connector",
      kind: "mcp-stdio",
      command: process.execPath,
      args: [resolve(root, "packages/canvas-connector-mcp/dist/index.js")],
      cwd: root,
      env: {
        MORROW_CANVAS_CATALOG_PATH: catalogPath,
        MORROW_CANVAS_CONNECTOR_STATE: join(directory, "connector.json"),
        MORROW_CANVAS_CONNECTOR_PORT: String(port),
        MORROW_CANVAS_CONNECTOR_TOKEN: "gateway-connector-secret-".repeat(3),
        MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: "a".repeat(32),
      },
      sourceDisposition: "adapted_owned",
      outputPrivacy: {},
      outputPrivacyDefault: {
        allowedFields: [],
        fieldPolicy: "scrub-sensitive",
        dataClass: "course",
        maxRecords: 10_000,
        maxBytes: 2_000_000,
        freeText: "allow",
        learnerTokens: true,
        artifactInspection: "deny",
        aiClientAdmission: "allow",
      },
    }],
    filters: { excludePrefixes: [], excludeNames: [] },
    operationJournal: { path: join(directory, "gateway.sqlite3") },
    privacy: { canvasOrigin: "browser-session", account: "local", principal: "local", learnerVaultPath: join(directory, "vault.json") },
    maxCatalogTools: 2_000,
  });
}

/**
 * REMEMBERABLE_EDIT_CATEGORIES (runtime.ts) is a hand copy of the `rules` of every
 * `rememberable: true` entry in `CURATED_CATEGORY_SPECS` (connector/extension/src/edit-policy.js),
 * because that data never crosses the Bridge wire (BridgeEditOption carries no `rules` field). The
 * two must be changed together; this reads the live export and checks the copy against it, the
 * same hand-sync discipline WI-4.1 used for the five Edit durations.
 */
describe("REMEMBERABLE_EDIT_CATEGORIES mirrors the live curated bundle rules", () => {
  it("holds the same rememberable ids, providers and rules as CURATED_CATEGORY_SPECS", async () => {
    const liveModule = await import(new URL("../../../connector/extension/src/edit-policy.js", import.meta.url).href) as {
      readonly CURATED_CATEGORY_SPECS: readonly {
        readonly id: string;
        readonly provider: "canvas" | "moodle";
        readonly rememberable?: boolean;
        readonly rules: readonly {
          readonly operationKey: string;
          readonly toolName: string;
          readonly allowedChangedFields: readonly string[];
          readonly requiresCanvasContentGuard?: boolean;
          readonly canvasContentGuardKind?: string;
        }[];
      }[];
    };
    const ruleKey = (rule: { operationKey: string; toolName: string; canvasContentGuardKind?: string }) =>
      `${rule.operationKey}\u0000${rule.toolName}\u0000${rule.canvasContentGuardKind || ""}`;
    const normalize = (rules: readonly { operationKey: string; toolName: string; allowedChangedFields: readonly string[]; requiresCanvasContentGuard?: boolean; canvasContentGuardKind?: string }[]) =>
      [...rules]
        .map((rule) => ({
          operationKey: rule.operationKey,
          toolName: rule.toolName,
          allowedChangedFields: [...rule.allowedChangedFields].sort(),
          ...(rule.requiresCanvasContentGuard ? { requiresCanvasContentGuard: true as const, canvasContentGuardKind: rule.canvasContentGuardKind } : {}),
        }))
        .sort((a, b) => ruleKey(a).localeCompare(ruleKey(b)));
    const live = liveModule.CURATED_CATEGORY_SPECS
      .filter((spec) => spec.rememberable === true)
      .map((spec) => ({ id: spec.id, provider: spec.provider, rules: normalize(spec.rules) }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const mirrored = REMEMBERABLE_EDIT_CATEGORIES
      .map((category) => ({ id: category.id, provider: category.provider, rules: normalize(category.rules) }))
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(mirrored).toEqual(live);
  });
});

describe("Runtime: the offer and the grant (WI-4.3)", () => {
  const root = resolve("../..");
  const extensionId = "a".repeat(32);
  const sourceBindingId = "canvas:test-account";
  const browserCatalogDigest = bridgeCatalogDigestForTests(root);
  const lesson = {
    page_id: "91", url: "lesson", title: "Cell structure",
    body: '<h2>Cell structure</h2><p>Cells have membranes.</p><img src="/courses/42/files/9?value=a>b&part=opaque">',
    published: true, front_page: false, editing_roles: "teachers", publish_at: null,
  };
  const newQuiz = {
    id: "77", course_id: "42", title: "Cell Structure Check",
    quiz_settings: { shuffle_answers: false, has_time_limit: false },
  };
  const binding = () => ({
    sourceBindingId,
    provider: "canvas" as const,
    origin: "https://school.instructure.com",
    courseId: "42",
    courseName: "Biology",
    principalFingerprint: "c".repeat(64),
    sessionGeneration: 1,
    catalogDigest: browserCatalogDigest,
    runtimeVerified: true,
    editPolicyRevision: 0,
    editOptionsAvailable: true,
  });

  const canvasAltTextOption: JsonObject = {
    id: "canvas_alt_text", group: "Canvas task bundles", label: "Add alternative text to images",
    description: "Add alternative text to one selected image without alternative text in a Canvas Page, Assignment, Discussion, Classic Quiz, or New Quiz item. It does not change other content.",
    availability: "edit", area: "accessibility", routine: true, rememberable: true,
  };
  const canvasPagesTextOption: JsonObject = {
    id: "canvas_pages_text", group: "Canvas task bundles", label: "Edit page text and titles",
    description: "Change the title or body text of an existing Canvas Page or the course Front Page. It does not create, publish, or remove a page.",
    availability: "edit", area: "pages", routine: true, rememberable: true,
  };

  let directory = "";
  let morrow: MorrowRuntime;
  let runtime: GatewayRuntime;
  let bridge: BridgeTestClient | undefined;
  let activeEditOptions: JsonObject[] = [];
  const editPolicySets: JsonObject[] = [];

  /** Waits for the connector to take up the course connections just sent. */
  const bindingsApplied = () => new Promise((resolveDelay) => setTimeout(resolveDelay, 20));

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "morrow-remember-kind-"));
    const port = await reserveLoopbackPort();
    const config = connectorConfig(directory, port);
    morrow = await MorrowRuntime.connect(config, { statePath: join(directory, "gateway.sqlite3") });
    runtime = morrow.gateway;
    await assertPortListening(port);
    bridge = await connectBridgeTestClient({
      port,
      token: "gateway-connector-secret-".repeat(3),
      extensionId,
      catalogDigest: browserCatalogDigest,
      bindings: [binding()],
    });
    bridge.onCommand((command) => {
      if (command.kind === "ui_state") {
        bridge?.respond(command, {});
        return;
      }
      if (command.kind === "edit_policy_set") {
        editPolicySets.push(command.editPolicySet as unknown as JsonObject);
        bridge?.respond(command, { schema: "morrow.bridge.edit-policy-set.v1", applied: true });
        return;
      }
      if (command.kind === "edit_policy_options_get") {
        bridge?.respond(command, {
          schema: "morrow.bridge.edit-options.v1",
          sourceBindingId,
          provider: "canvas",
          catalogDigest: browserCatalogDigest,
          policyRevision: 0,
          runtimeVerified: true,
          options: activeEditOptions,
        });
        return;
      }
      bridge?.respond(command, {
        schema: "morrow.canvas-browser-result.v1",
        ok: true,
        sent: true,
        status: 200,
        ...(command.toolName === "canvas_show_page_courses" ? { pageBodySha256: sha256Text(lesson.body) } : {}),
        data: command.toolName === "canvas_show_page_courses" ? lesson
          : command.toolName === "canvas_show_revision_courses_latest" ? { revision_id: "1", latest: true, url: lesson.url, title: lesson.title, body: lesson.body }
          : command.toolName === "canvas_get_new_quiz" ? newQuiz
          : { id: "42", name: "Biology" },
      });
    });
  }, CASE_TIMEOUT_MS);

  afterAll(async () => {
    await bridge?.close();
    await morrow?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("offers to remember an alternative-text repair", async () => {
    const plan = await planPageImageAltRepair(runtime, {
      source_binding_id: sourceBindingId, course_id: "42", page_url: "lesson",
      expected_body_sha256: sha256Text(lesson.body), image_index: 1,
      image_src_sha256: sha256Text("/courses/42/files/9?value=a>b&part=opaque"),
      alt_text: "Cell membrane diagram", decorative: false,
    });
    expect(plan.isError, JSON.stringify(plan)).not.toBe(true);
    const id = operationId(plan as unknown as JsonObject);
    activeEditOptions = [canvasAltTextOption];
    try {
      const offer = await runtime.rememberOffer(id);
      expect(offer).not.toBeNull();
      // Edit is not timed: the offer names the bundle and no end time.
      expect(offer).toEqual({ categoryId: "canvas_alt_text", label: "Add alternative text to images" });
    } finally {
      activeEditOptions = [];
      runtime.cancelOperation(id);
    }
  }, CASE_TIMEOUT_MS);

  it("offers nothing for a removal", async () => {
    const deleted = await runtime.call("canvas_delete_new_quiz", {
      course_id: "42", assignment_id: "77", _morrow: { source_binding_id: sourceBindingId },
    });
    const id = operationId(deleted);
    try {
      expect(await runtime.rememberOffer(id)).toBeNull();
    } finally {
      runtime.cancelOperation(id);
    }
  }, CASE_TIMEOUT_MS);

  it("offers nothing for a New Quiz settings plan", async () => {
    const plan = await planNewQuizSettings(runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77",
      settings: { shuffle_answers: true },
    });
    expect(plan.isError, JSON.stringify(plan)).not.toBe(true);
    const id = operationId(plan as unknown as JsonObject);
    try {
      expect(await runtime.rememberOffer(id)).toBeNull();
    } finally {
      runtime.cancelOperation(id);
    }
  }, CASE_TIMEOUT_MS);

  it("offers nothing for a plan whose changed fields do not resolve to exactly one rememberable bundle", async () => {
    // canvas_pages_text only ever allows wiki_page_body and wiki_page_title (a Page's own text),
    // never wiki_page_editing_roles (a setting): a plan that changes both together maps to no
    // rememberable bundle at all, the same "not one category" shape a mixed batch would leave.
    const changed = await runtime.call("canvas_update_create_page_courses", {
      course_id: "42", url_or_id: "lesson",
      wiki_page_title: "Cell structure and function",
      wiki_page_editing_roles: "teachers,students",
      _morrow: { source_binding_id: sourceBindingId },
    });
    const id = operationId(changed);
    activeEditOptions = [canvasPagesTextOption];
    try {
      expect(await runtime.rememberOffer(id)).toBeNull();
    } finally {
      activeEditOptions = [];
      runtime.cancelOperation(id);
    }
  }, CASE_TIMEOUT_MS);

  it("offers nothing for every tool the catalog marks destructive (WI-4.6)", async () => {
    // rememberOffer's own guard (runtime.ts: "the tool is a removal" check, before any bundle
    // match) is what this proves, not just that REMEMBERABLE_EDIT_CATEGORIES never names a
    // destructive tool: call the runtime for a spread of destructive tools across resource
    // families and check the offer itself, the same call-then-assert shape as "offers nothing
    // for a removal" above, which this generalizes beyond the one delete case.
    const NUMERIC_ID_PATTERN = "^[1-9][0-9]*$";
    const destructiveBrowserTools = runtime.catalog.tools.filter((tool) => (
      tool.annotations?.destructiveHint === true
      && (tool.capability?.provider === "canvas" || tool.capability?.provider === "moodle")
    ));
    expect(destructiveBrowserTools.length).toBeGreaterThan(0);
    // Only tools whose required arguments are plain numeric ids can be called with synthetic
    // values; that is nearly all of them, and still a representative spread across families.
    const callableTools = destructiveBrowserTools.filter((tool) => {
      const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : [];
      const properties = isJsonObject(tool.inputSchema.properties) ? tool.inputSchema.properties : {};
      return required.every((key) => (
        typeof key === "string" && isJsonObject(properties[key]) && properties[key].pattern === NUMERIC_ID_PATTERN
      ));
    });
    const sampleSize = 12;
    const stride = Math.max(1, Math.floor(callableTools.length / sampleSize));
    const sample = callableTools.filter((_, index) => index % stride === 0);
    expect(sample.length).toBeGreaterThanOrEqual(Math.min(sampleSize, callableTools.length));

    for (const tool of sample) {
      const required = tool.inputSchema.required as string[];
      const args: JsonObject = { _morrow: { source_binding_id: sourceBindingId } };
      // course_id must match the bound course (42); every other numeric id is synthetic.
      for (const key of required) args[key] = key === "course_id" ? "42" : "1";
      const result = await runtime.call(tool.publicName, args);
      const id = operationId(result);
      try {
        expect(await runtime.rememberOffer(id), tool.publicName).toBeNull();
      } finally {
        runtime.cancelOperation(id);
      }
    }
  }, CASE_TIMEOUT_MS);

  it("asks the Bridge for an untimed grant that stays until the person returns the course to Plan", async () => {
    const plan = await planPageImageAltRepair(runtime, {
      source_binding_id: sourceBindingId, course_id: "42", page_url: "lesson",
      expected_body_sha256: sha256Text(lesson.body), image_index: 1,
      image_src_sha256: sha256Text("/courses/42/files/9?value=a>b&part=opaque"),
      alt_text: "Cell membrane diagram", decorative: false,
    });
    const id = operationId(plan as unknown as JsonObject);
    activeEditOptions = [canvasAltTextOption];
    editPolicySets.length = 0;
    try {
      await runtime.rememberKind(id);
      expect(editPolicySets).toEqual([{
        mode: "edit",
        merge: true,
        selections: [{ sourceBindingId, expectedPolicyRevision: 0, enabledCategories: ["canvas_alt_text"] }],
      }]);
    } finally {
      activeEditOptions = [];
      runtime.cancelOperation(id);
    }
  }, CASE_TIMEOUT_MS);

  it("an Edit access review asks the Bridge to add the reviewed kinds to the course's current grant", async () => {
    activeEditOptions = [canvasPagesTextOption];
    editPolicySets.length = 0;
    try {
      const prepared = await runtime.prepareBrowserEditAccess("edit", [{ sourceBindingId, enabledCategories: ["canvas_pages_text"] }]);
      const editAccessId = String(runtime.editAccessReviews.create(prepared, "http://127.0.0.1:9").editAccessId);
      expect(runtime.editAccessReviews.approve(editAccessId)).toMatchObject({ approved: true });
      await runtime.editAccessReviews.run(editAccessId);
      expect(editPolicySets).toEqual([{
        mode: "edit",
        merge: true,
        selections: [{ sourceBindingId, expectedPolicyRevision: 0, enabledCategories: ["canvas_pages_text"] }],
      }]);
    } finally {
      activeEditOptions = [];
    }
  }, CASE_TIMEOUT_MS);

  it("refuses Edit from a conversation for an action that needs a field choice, because the grant would change nothing", async () => {
    activeEditOptions = [{
      id: "action:canvas:canvas_edit_assignment", group: "Canvas · Assignments", label: "Edit an assignment",
      description: "Edit an assignment. This action can change 49 different settings. Morrow does not grant all of them at once, so selecting it alone does not let Morrow change any of them.",
      availability: "edit", tier: "standard", destructive: false, requiresFieldSelection: true,
    }];
    try {
      const refused = runtime.prepareBrowserEditAccess("edit", [{ sourceBindingId, enabledCategories: ["action:canvas:canvas_edit_assignment"] }]);
      await expect(refused).rejects.toBeInstanceOf(EditCategoryUnavailableError);
      await expect(refused).rejects.toMatchObject({
        categoryId: "action:canvas:canvas_edit_assignment",
        reason: "This action can change many different settings, so Edit does not cover it, and Morrow asks before each change. A task bundle in Morrow Bridge Plan and Edit settings may cover the change you need.",
      });
    } finally {
      activeEditOptions = [];
    }
  }, CASE_TIMEOUT_MS);

  it("does not fail the change when the grant fails", async () => {
    // rememberKind never touches the operation it was given: a grant it cannot make (here,
    // because rememberOffer found no bundle to grant) reports "failed" and leaves that operation
    // exactly as it was, so a review page that already approved the change is never undone.
    const deleted = await runtime.call("canvas_delete_new_quiz", {
      course_id: "42", assignment_id: "78", _morrow: { source_binding_id: sourceBindingId },
    });
    const id = operationId(deleted);
    try {
      const before = runtime.effects.get(id);
      await expect(runtime.rememberKind(id)).resolves.toBe("failed");
      expect(runtime.effects.get(id)).toEqual(before);
    } finally {
      runtime.cancelOperation(id);
    }
  }, CASE_TIMEOUT_MS);
});
