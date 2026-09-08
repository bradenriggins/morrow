import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { isJsonObject, sha256Json, sha256Text, type JsonObject } from "@morrow/contracts";
import { parseGatewayConfig } from "../src/config.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";
import { GatewayRuntime } from "../src/runtime.js";
import { createFullMorrowServer } from "../src/full-server.js";
import { checkNewQuiz } from "../src/quiz-check.js";
import { planAssignmentImageAltRepair, planDiscussionImageAltRepair, planPageCorrection, planPageImageAltRepair } from "../src/page-correction.js";
import { bridgeCatalogDigestForTests } from "./fixtures/bridge-catalog-digest.js";
import { connectBridgeTestClient, type BridgeTestClient } from "./fixtures/bridge-client.js";
import { assertPortListening, reserveLoopbackPort } from "./fixtures/loopback-port.js";

/**
 * The deadline for one case, and for the fixture a group of cases shares. Every
 * case here drives a real connector process over a real loopback bridge; the
 * slowest one measured under a second of work on this machine, and the fixture
 * that starts the connector measured about four. Change the deadline here, not
 * per case.
 */
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

async function approveBatch(url: string): Promise<void> {
  const page = await fetch(url);
  const body = await page.text();
  const nonce = /name="nonce" value="([^"]+)"/.exec(body)?.[1];
  const cookie = page.headers.get("set-cookie")?.split(";", 1)[0];
  expect(nonce).toBeTruthy();
  expect(cookie).toBeTruthy();
  const response = await fetch(`${url}/approve`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookie!,
      origin: new URL(url).origin,
      referer: url,
    },
    body: new URLSearchParams({ nonce: nonce! }),
  });
  expect(response.status).toBe(200);
}

describe("Canvas connector gateway path", () => {
  /**
   * One connector process, one bridge connection and one course connection
   * serve every case below, the way one signed-in browser session serves one
   * teacher. The cases run in file order and share that session, so each one
   * inherits the running write count: writeCommands is how many writes the
   * Bridge has been asked to make since the session opened, and a case that
   * must not write asserts the count it inherited.
   */
  describe("one signed-in Canvas session", () => {
    const root = resolve("../..");
    const extensionId = "a".repeat(32);
    const sourceBindingId = "canvas:test-account";
    const browserCatalogDigest = bridgeCatalogDigestForTests(root);
    const detailedEditPermission = (
      editPolicy: "canvas_page_content" | "canvas_assignment_due_date" | "canvas_new_quiz_nested_image_alt" | "canvas_inbox_messages" | false,
      expiresAt?: number,
    ) => editPolicy ? {
      schema: "morrow.bridge.edit-permission.v1" as const,
      revision: 1,
      scopeDigest: "d".repeat(64),
      catalogDigest: browserCatalogDigest,
      sourceBindingId,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      enabledCategories: [editPolicy],
      rules: editPolicy === "canvas_new_quiz_nested_image_alt" ? ["new_quiz_choice_image_alt", "new_quiz_answer_feedback_image_alt", "new_quiz_feedback_image_alt"].map((kind) => ({
        operationKey: "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item",
        toolName: "canvas_update_quiz_item",
        allowedChangedFields: [],
        requiresCanvasContentGuard: true,
        canvasContentGuardKind: kind,
      })) : editPolicy === "canvas_inbox_messages" ? [{
        operationKey: "canvas.private.conversation.send.v1",
        toolName: "canvas_send_private_conversation",
        allowedChangedFields: [],
      }] : editPolicy === "canvas_assignment_due_date" ? [{
        operationKey: "PUT /v1/courses/{course_id}/assignments/{id}#edit_assignment",
        toolName: "canvas_edit_assignment",
        allowedChangedFields: ["assignment_due_at"],
      }] : [{
        operationKey: "PUT /v1/courses/{course_id}/pages/{url_or_id}#update_create_page_courses",
        toolName: "canvas_update_create_page_courses",
        allowedChangedFields: [],
        requiresCanvasContentGuard: true,
        canvasContentGuardKind: "page_text",
      }],
    } : undefined;
    const binding = (
      editPolicy: "canvas_page_content" | "canvas_assignment_due_date" | "canvas_new_quiz_nested_image_alt" | "canvas_inbox_messages" | false = "canvas_page_content",
      expiresAt?: number,
    ) => {
      const permission = detailedEditPermission(editPolicy, expiresAt);
      return {
      sourceBindingId,
      provider: "canvas" as const,
      origin: "https://school.instructure.com",
      courseId: "42",
      principalFingerprint: "c".repeat(64),
      sessionGeneration: 1,
      catalogDigest: browserCatalogDigest,
      runtimeVerified: true,
      ...(permission ? {
        editPolicyRevision: permission.revision,
        editOptionsAvailable: true,
        editPermission: {
          schema: permission.schema,
          revision: permission.revision,
          scopeDigest: permission.scopeDigest,
          catalogDigest: permission.catalogDigest,
          sourceBindingId: permission.sourceBindingId,
          ...(permission.expiresAt === undefined ? {} : { expiresAt: permission.expiresAt }),
        },
      } : {}),
    };
    };
    const lesson = { page_id: "91", url: "lesson", title: "Cell structure", body: '<h2>Cell structure</h2><p>Cells have membranes.</p><img src="/courses/42/files/9?value=a>b&part=opaque">', published: true, front_page: false, editing_roles: "teachers", publish_at: null };
    const assignment = { id: "88", course_id: "42", name: "Cell transport reflection", description: '<p>Explain active transport.</p><img src="/courses/42/files/10">', due_at: "2026-09-08T17:00:00Z" };
    const discussion = { id: "89", course_id: "42", title: "Cell transport discussion", message: '<p>Discuss one transport process.</p><img src="/courses/42/files/11">', discussion_type: "threaded", published: true };
    const classicQuiz = { id: "77", course_id: "42", title: "Cell Structure Check", description: '<p>Review the diagram.</p><img src="/courses/42/files/16">', quiz_type: "assignment", points_possible: 25, published: true, show_correct_answers: true };
    /**
     * One long question body. The check hashes a body to compare it across
     * quizzes and never copies it into a report, and the assertion below is
     * what proves it, so this only has to be longer than the longest text the
     * report itself writes: a 300-character name (src/quiz-check.ts). It was
     * 84,007 characters, which proved nothing more and carried 84 KB through
     * every read, hash and bridge frame in this file.
     */
    const repeatedBody = `<p>${"Explain the process. ".repeat(100)}</p>`;
    const quizItems = [
      { id: "1", position: 1, points_possible: 5, entry_type: "Item", entry: {
        title: "Cell structure", item_body: "Which structure contains DNA?", interaction_type_slug: "choice",
        interaction_data: { choices: [{ id: "a", item_body: "Nucleus" }, { id: "b", itemBody: "Membrane" }] },
        scoring_data: { value: "missing-choice" },
      } },
      { id: "2", position: 2, points_possible: 5, entry_type: "Item", entry: {
        title: "Cell statement", item_body: "Cells have membranes.", interaction_type_slug: "true-false",
        interaction_data: { true_choice: "True", false_choice: "False" }, scoring_data: { value: false },
      } },
      { id: "3", position: 3, points_possible: 5, entry_type: "Item", entry: {
        title: "Cell parts", item_body: "Choose two cell parts.", interaction_type_slug: "multi-answer",
        interaction_data: { choices: [{ id: "a", item_body: "Nucleus" }, { id: "b", item_body: "Membrane" }] },
        scoring_data: { value: ["a", "b"] },
      } },
      { id: "4", position: 4, points_possible: 5, entry_type: "Item", entry: {
        title: "Written explanation", item_body: repeatedBody, interaction_type_slug: "essay",
      } },
    ];
    const pageInput = { source_binding_id: sourceBindingId, course_id: "42", page_url: "lesson", find_text: "Cells have membranes.", replace_text: "Cells have protective membranes." };

    let directory = "";
    let config: ReturnType<typeof connectorConfig>;
    let morrow: MorrowRuntime;
    let runtime: GatewayRuntime;
    let bridge: BridgeTestClient | undefined;
    let activeEditPermission = detailedEditPermission("canvas_page_content");
    let writeCommands = 0;
    let partialQuiz = false;
    let filteredPage = false;
    let pagePlanOperationId = "";
    let pageContentGuard: JsonObject;
    let conversationId = "";

    /** Waits for the connector to take up the course connections just sent. */
    const bindingsApplied = () => new Promise((resolveDelay) => setTimeout(resolveDelay, 20));

    beforeAll(async () => {
      directory = mkdtempSync(join(tmpdir(), "morrow-canvas-connector-gateway-"));
      const port = await reserveLoopbackPort();
      config = connectorConfig(directory, port);
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
        if (command.kind === "edit_policy_options_get") {
          bridge?.respond(command, {
            schema: "morrow.bridge.edit-options.v1",
            sourceBindingId,
            provider: "canvas",
            catalogDigest: browserCatalogDigest,
            policyRevision: 1,
            runtimeVerified: true,
            options: [],
            ...(activeEditPermission ? { editPermission: activeEditPermission } : {}),
          });
          return;
        }
        if (command.kind === "invoke_write") {
          writeCommands += 1;
          expect(command.outerGrant).toMatchObject({ dispatchAttempt: 1 });
          if (command.toolName === "canvas_update_create_page_courses") {
            expect(command.outerGrant?.authorization).toEqual({ kind: "edit_scope", policyDigest: "d".repeat(64), policyRevision: 1 });
          }
          if (command.toolName === "canvas_edit_assignment") {
            expect(command.outerGrant?.authorization).toEqual({ kind: "edit_scope", policyDigest: "d".repeat(64), policyRevision: 1 });
          }
          if (command.toolName === "canvas_send_private_conversation") {
            expect(command.outerGrant?.authorization).toEqual({ kind: "edit_scope", policyDigest: "d".repeat(64), policyRevision: 1 });
            expect(command.arguments).toEqual({});
            expect(command.privateConversation).toEqual({
              schema: "morrow.canvas-conversation.private.v1",
              action: "create",
              courseId: "42",
              recipients: ["9001", "group_12_students"],
              subject: "Jane Doe private subject marker",
              body: "Jane Doe private body marker must not leave the Canvas Inbox review.",
              groupConversation: true,
            });
          }
        }
        bridge?.respond(command, {
          schema: "morrow.canvas-browser-result.v1",
          ok: true,
          sent: true,
          status: 200,
          truncated: partialQuiz && command.toolName === "canvas_list_quiz_items",
          ...(command.toolName === "canvas_show_page_courses" ? { pageBodySha256: sha256Text(lesson.body) } : {}),
          data: command.toolName === "canvas_show_page_courses" ? { ...lesson, body: filteredPage ? "[filtered]" : lesson.body }
            : command.toolName === "canvas_show_revision_courses_latest" ? { revision_id: "1", latest: true, url: lesson.url, title: lesson.title, body: lesson.body }
            : command.toolName === "canvas_get_new_quiz"
            ? { id: command.arguments.assignment_id, course_id: "42", title: command.arguments.assignment_id === "77" ? "Cell Structure Check" : "Practice quiz" }
              : command.toolName === "canvas_list_quiz_items"
                ? command.arguments.assignment_id === "77" ? quizItems : [{ ...quizItems[3], id: "8" }]
              : command.toolName === "canvas_list_users_in_course_users"
                ? [{ id: "9001", name: "Jane Doe", email: "jane.doe@example.edu", login_id: "jdoe" }]
              : command.toolName === "canvas_add_course_to_favorites"
                ? {
                  id: "42",
                  message: "Student Jane Doe added this course to favorites.",
                  last_edited_by: { id: "9001", name: "Jane Doe", email: "jane.doe@example.edu" },
                }
              : ["canvas_get_single_assignment", "canvas_edit_assignment"].includes(command.toolName)
                ? assignment
              : ["canvas_get_single_topic_courses", "canvas_update_topic_courses"].includes(command.toolName)
                ? discussion
                : command.toolName === "canvas_get_single_quiz"
                  ? classicQuiz
                : { id: "42", name: "Biology" },
          ...(command.kind === "invoke_write" ? {
            verification: {
              schema: "morrow.browser-verification.v1",
              status: "verified",
              strategy: "collection-contains-target",
              readTool: "canvas_list_favorite_courses",
              evidence: "fresh_readback_matches_requested_postcondition",
            },
          } : {}),
        });
      });
    }, CASE_TIMEOUT_MS);

    afterAll(async () => {
      await bridge?.close();
      await morrow?.close();
      if (directory) rmSync(directory, { recursive: true, force: true });
    });

    it("reads the selected Canvas course through its API id field", async () => {
      await bindingsApplied();
      const course = await runtime.call("canvas_get_single_course_courses", {
        id: "42",
        _morrow: { source_binding_id: sourceBindingId },
      });
      expect(course.isError).not.toBe(true);
      expect(course.structuredContent).toMatchObject({
        schema: "morrow.result.v1",
        status: "succeeded",
        data: {
          schema: "morrow.canvas-connector.result.v1",
          ok: true,
          provider: "canvas",
          commandKind: "invoke_read",
          result: { data: { id: "42", name: "Biology" } },
        },
      });
      expect(writeCommands).toBe(0);
    });

    it("returns the selected Canvas course through the compact MCP boundary", async () => {
      await bindingsApplied();
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = serveStdio(() => createFullMorrowServer(morrow), { transport: serverTransport });
      const client = new Client(
        { name: "morrow-canvas-course-first-read", version: "1" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      try {
        await client.connect(clientTransport);
        const course = await client.callTool({
          name: "morrow_capability_read",
          arguments: {
            name: "canvas_get_single_course_courses",
            arguments: {
              id: "42",
              _morrow: { source_binding_id: sourceBindingId },
            },
          },
        });
        expect(course.isError, JSON.stringify(course)).not.toBe(true);
        expect(course.structuredContent).toMatchObject({
          schema: "morrow.result.v1",
          status: "succeeded",
          data: {
            schema: "morrow.canvas-connector.result.v1",
            ok: true,
            provider: "canvas",
            commandKind: "invoke_read",
            result: { data: { id: "42", name: "Biology" } },
          },
        });
      } finally {
        await client.close();
        await server.close();
      }
      expect(writeCommands).toBe(0);
    }, CASE_TIMEOUT_MS);

    it("checks the structure of two New Quizzes and writes nothing", async () => {
      // The report keeps question titles and counts, never a question body.
      expect(repeatedBody.length).toBe(2_107);
      const checkInput = { source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", compare_quiz_ids: ["78"], expected_question_count: 5, expected_question_points: 25 };
      const checked = await checkNewQuiz(runtime, checkInput);
      expect(checked.structuredContent).toMatchObject({
        status: "needs_attention", course: { name: "Biology" }, findingCount: 3, repeatedGroupCount: 1,
        quizzes: [{ name: "Cell Structure Check", directQuestionCount: 4, directQuestionPoints: 20, totalsComplete: true, answerSettingsChecked: 3 }, { name: "Practice quiz", directQuestionCount: 1 }],
        findings: [{ question: "Cell structure", message: "The saved correct answer does not match the answer choices." }, { message: "Expected 5 questions; found 4." }, { message: "Expected 25 question points; found 20." }],
        repeatedContent: [[{ quiz: "Cell Structure Check", question: "Written explanation" }, { quiz: "Practice quiz", question: "Written explanation" }]],
        incomplete: [],
      });
      expect(JSON.stringify(checked)).not.toContain(repeatedBody);
      expect(writeCommands).toBe(0);
      partialQuiz = true;
      const partial = await checkNewQuiz(runtime, { ...checkInput, compare_quiz_ids: [] });
      expect(partial.structuredContent).toMatchObject({ status: "incomplete", quizzes: [], findingCount: 0 });
      expect(JSON.stringify(partial)).toContain("Do not treat this as a complete check");
      expect(writeCommands).toBe(0);
      partialQuiz = false;
    }, CASE_TIMEOUT_MS);

    it("plans a guarded Page correction from the saved page", async () => {
      const pagePlan = await planPageCorrection(runtime, pageInput);
      expect(pagePlan.isError, JSON.stringify(pagePlan)).not.toBe(true);
      const savedPagePlan = runtime.effects.get(operationId(pagePlan as unknown as JsonObject));
      expect(savedPagePlan.plan.arguments).toMatchObject({ course_id: "42", url_or_id: "lesson", _morrow: { canvas_content_guard: { course_id: "42", page_id: "91", revision_id: "1", body_sha256: sha256Text(lesson.body), kind: "page_text", find_text: pageInput.find_text, replace_text: pageInput.replace_text } } });
      expect(savedPagePlan.plan.arguments).not.toHaveProperty("wiki_page_body");
      expect(savedPagePlan).toMatchObject({ state: "approved", plan: { authorization: { kind: "edit_scope", policyDigest: "d".repeat(64), policyRevision: 1 } } });
      expect(JSON.stringify(pagePlan)).not.toContain(lesson.body);
      pagePlanOperationId = savedPagePlan.operationId;
      pageContentGuard = savedPagePlan.plan.arguments._morrow.canvas_content_guard;
    }, CASE_TIMEOUT_MS);

    it("plans image-alt repairs for a page, an assignment, a discussion and a New Quiz item", async () => {
      const staleImageAltPlan = await planPageImageAltRepair(runtime, {
        source_binding_id: sourceBindingId, course_id: "42", page_url: "lesson",
        expected_body_sha256: "0".repeat(64), image_index: 1,
        image_src_sha256: sha256Text("/courses/42/files/9?value=a>b&part=opaque"),
        alt_text: "Cell membrane diagram", decorative: false,
      });
      expect(staleImageAltPlan.isError).toBe(true);
      expect(JSON.stringify(staleImageAltPlan)).toContain("changed since this accessibility signal");
      const imageAltPlan = await planPageImageAltRepair(runtime, {
        source_binding_id: sourceBindingId, course_id: "42", page_url: "lesson",
        expected_body_sha256: sha256Text(lesson.body), image_index: 1,
        image_src_sha256: sha256Text("/courses/42/files/9?value=a>b&part=opaque"),
        alt_text: "Cell membrane diagram", decorative: false,
      });
      expect(imageAltPlan.structuredContent).toMatchObject({ effectState: "awaiting_approval" });
      const savedImageAltPlan = runtime.effects.get(operationId(imageAltPlan as unknown as JsonObject));
      expect(savedImageAltPlan).toMatchObject({ state: "awaiting_approval", plan: { authorization: { kind: "review" }, arguments: { _morrow: { canvas_content_guard: { kind: "page_image_alt", image_index: 1 } } } } });
      expect(JSON.stringify(savedImageAltPlan.plan.arguments)).not.toContain("/courses/42/files/9");
      runtime.cancelOperation(savedImageAltPlan.operationId);
      const assignmentImageAltPlan = await planAssignmentImageAltRepair(runtime, {
        source_binding_id: sourceBindingId, course_id: "42", assignment_id: "88",
        expected_body_sha256: sha256Text(assignment.description), image_index: 1,
        image_src_sha256: sha256Text("/courses/42/files/10"),
        alt_text: "Cell transport diagram", decorative: false,
      });
      expect(assignmentImageAltPlan.structuredContent).toMatchObject({ effectState: "awaiting_approval" });
      const savedAssignmentImageAltPlan = runtime.effects.get(operationId(assignmentImageAltPlan as unknown as JsonObject));
      expect(savedAssignmentImageAltPlan).toMatchObject({ state: "awaiting_approval", plan: { authorization: { kind: "review" }, arguments: {
        course_id: "42", id: "88", _morrow: { canvas_content_guard: { kind: "assignment_image_alt", course_id: "42", assignment_id: "88", image_index: 1, alt_text: "Cell transport diagram" } },
      } } });
      expect(JSON.stringify(savedAssignmentImageAltPlan.plan.arguments)).not.toContain(assignment.description);
      runtime.cancelOperation(savedAssignmentImageAltPlan.operationId);
      const discussionImageAltPlan = await planDiscussionImageAltRepair(runtime, {
        source_binding_id: sourceBindingId, course_id: "42", topic_id: "89",
        expected_body_sha256: sha256Text(discussion.message), image_index: 1,
        image_src_sha256: sha256Text("/courses/42/files/11"),
        alt_text: "Diffusion diagram", decorative: false,
      });
      expect(discussionImageAltPlan.structuredContent).toMatchObject({ effectState: "awaiting_approval" });
      const savedDiscussionImageAltPlan = runtime.effects.get(operationId(discussionImageAltPlan as unknown as JsonObject));
      expect(savedDiscussionImageAltPlan).toMatchObject({ state: "awaiting_approval", plan: { authorization: { kind: "review" }, arguments: {
        course_id: "42", topic_id: "89", _morrow: { canvas_content_guard: { kind: "discussion_image_alt", course_id: "42", topic_id: "89", image_index: 1, alt_text: "Diffusion diagram" } },
      } } });
      expect(JSON.stringify(savedDiscussionImageAltPlan.plan.arguments)).not.toContain(discussion.message);
      runtime.cancelOperation(savedDiscussionImageAltPlan.operationId);
      activeEditPermission = detailedEditPermission("canvas_new_quiz_nested_image_alt");
      bridge?.updateBindings([binding("canvas_new_quiz_nested_image_alt")]);
      await bindingsApplied();
      for (const kind of ["new_quiz_choice_image_alt", "new_quiz_answer_feedback_image_alt", "new_quiz_feedback_image_alt"]) {
        const nested = await runtime.planOperationWithCurrentEditPermission("canvas_update_quiz_item", {
          course_id: "42", assignment_id: "77", item_id: "12",
          _morrow: { source_binding_id: sourceBindingId, canvas_content_guard: {
            kind, course_id: "42", assignment_id: "77", item_id: "12",
            ...(kind === "new_quiz_feedback_image_alt" ? { feedback_type: "correct" } : { choice_id: "a" }),
            body_sha256: "1".repeat(64), protected_state_sha256: "2".repeat(64), image_index: 1,
            image_src_sha256: "3".repeat(64), alt_text: "Cell membrane diagram", decorative: false,
          } },
        });
        expect(nested.isError, JSON.stringify(nested)).not.toBe(true);
        const operation = runtime.effects.get(operationId(nested));
        expect(operation).toMatchObject({ state: "approved", plan: { authorization: { kind: "edit_scope" } } });
        runtime.cancelOperation(operation.operationId);
      }
      expect(writeCommands).toBe(0);
    }, CASE_TIMEOUT_MS);

    it("refuses the planned Page edit after the Edit grant is taken away", async () => {
      activeEditPermission = undefined;
      bridge?.updateBindings([binding(false)]);
      await bindingsApplied();
      const revoked = await runtime.dispatchOperation(pagePlanOperationId);
      expect(revoked.isError).toBe(true);
      expect(writeCommands).toBe(0);
      runtime.cancelOperation(pagePlanOperationId);
    }, CASE_TIMEOUT_MS);

    it("saves one guarded Page edit under the Edit grant", async () => {
      activeEditPermission = detailedEditPermission("canvas_page_content");
      bridge?.updateBindings([binding()]);
      await bindingsApplied();
      const edited = await runtime.call("canvas_update_create_page_courses", {
        course_id: "42",
        url_or_id: "lesson",
        _morrow: { source_binding_id: sourceBindingId, canvas_content_guard: pageContentGuard },
      });
      expect(edited.structuredContent).toMatchObject({ effectState: "verified", verification: { status: "verified" } });
      expect(writeCommands).toBe(1);
    }, CASE_TIMEOUT_MS);

    it("changes only an assignment due date, and sends the three edits outside that grant for review", async () => {
      activeEditPermission = detailedEditPermission("canvas_assignment_due_date");
      bridge?.updateBindings([binding("canvas_assignment_due_date")]);
      await bindingsApplied();
      const dueDateEdit = await runtime.call("canvas_edit_assignment", {
        course_id: "42", id: "88", assignment_due_at: "2026-09-10T17:00:00Z",
        _morrow: { source_binding_id: sourceBindingId },
      });
      expect(dueDateEdit.structuredContent).toMatchObject({ effectState: "verified", verification: { status: "verified" } });
      expect(writeCommands).toBe(2);
      const missingDueDateEdit = await runtime.call("canvas_edit_assignment", {
        course_id: "42", id: "88",
        _morrow: { source_binding_id: sourceBindingId },
      });
      const missingDueDateOperation = runtime.effects.get(operationId(missingDueDateEdit));
      if (!missingDueDateOperation) throw new Error("missing due-date operation is missing");
      expect(missingDueDateOperation).toMatchObject({ state: "awaiting_approval", plan: { authorization: { kind: "review" } } });
      runtime.cancelOperation(missingDueDateOperation.operationId);
      const refusedDueDateEdit = await runtime.call("canvas_edit_assignment", {
        course_id: "42", id: "88", assignment_due_at: "2026-09-10T17:00:00Z", assignment_name: "Must stay unchanged",
        _morrow: { source_binding_id: sourceBindingId },
      });
      const refusedDueDateOperation = runtime.effects.get(operationId(refusedDueDateEdit));
      if (!refusedDueDateOperation) throw new Error("refused due-date operation is missing");
      expect(refusedDueDateOperation).toMatchObject({ state: "awaiting_approval", plan: { authorization: { kind: "review" } } });
      runtime.cancelOperation(refusedDueDateOperation.operationId);
      const expiredAt = Date.now() - 1;
      activeEditPermission = detailedEditPermission("canvas_assignment_due_date", expiredAt);
      bridge?.updateBindings([binding("canvas_assignment_due_date", expiredAt)]);
      await bindingsApplied();
      const expiredDueDateEdit = await runtime.call("canvas_edit_assignment", {
        course_id: "42", id: "88", assignment_due_at: "2026-09-10T17:00:00Z",
        _morrow: { source_binding_id: sourceBindingId },
      });
      const expiredDueDateOperation = runtime.effects.get(operationId(expiredDueDateEdit));
      if (!expiredDueDateOperation) throw new Error("expired due-date operation is missing");
      expect(expiredDueDateOperation).toMatchObject({ state: "awaiting_approval", plan: { authorization: { kind: "review" } } });
      runtime.cancelOperation(expiredDueDateOperation.operationId);
      expect(writeCommands).toBe(2);
    }, CASE_TIMEOUT_MS);

    it("refuses a Page correction it cannot plan from the saved page", async () => {
      activeEditPermission = detailedEditPermission("canvas_page_content");
      bridge?.updateBindings([binding()]);
      await bindingsApplied();
      filteredPage = true;
      const filteredPlan = await planPageCorrection(runtime, pageInput);
      expect(filteredPlan.isError).toBe(true);
      expect(JSON.stringify(filteredPlan)).toContain("No change was planned");
      expect(writeCommands).toBe(2);
      filteredPage = false;
      const originalLessonBody = lesson.body;
      lesson.body = "<p>Use &times here.</p>";
      const entityPlan = await planPageCorrection(runtime, { ...pageInput, find_text: "times", replace_text: "plus" });
      expect(entityPlan.isError).toBe(true);
      expect(JSON.stringify(entityPlan)).toContain("HTML character reference");
      expect(writeCommands).toBe(2);
      lesson.body = originalLessonBody;
    }, CASE_TIMEOUT_MS);

    it("names the course and quiz a change would touch, for review", async () => {
      const reviewPlan = await runtime.call("canvas_create_quiz_item", {
        course_id: "42", assignment_id: "77", item_entry_title: "Cell structure",
        _morrow: { source_binding_id: sourceBindingId },
      });
      expect(await runtime.operationReviewContext(operationId(reviewPlan))).toMatchObject({ targets: [
        { field: "course_id", name: "Biology" },
        { field: "assignment_id", label: "Quiz", name: "Cell Structure Check" },
      ] });
      expect(writeCommands).toBe(2);
      runtime.cancelOperation(operationId(reviewPlan));
    }, CASE_TIMEOUT_MS);

    it("sends one approved course change, checks it again, and keeps learner identity out of the result", async () => {
      const planned = await runtime.call("canvas_add_course_to_favorites", {
        id: "42",
        _morrow: {
          operation_id: "operation:canvas-connector-gateway-test",
          source_binding_id: sourceBindingId,
        },
      });
      const id = operationId(planned);
      expect(planned.structuredContent).toMatchObject({ status: "awaiting_approval" });
      runtime.approveOperation(id);
      const dispatched = await runtime.dispatchOperation(id);
      expect(dispatched.structuredContent).toMatchObject({ effectState: "verified", verification: { status: "verified" } });
      expect(writeCommands).toBe(3);
      const recordedVerification = await runtime.reconcileOperation(id);
      expect(recordedVerification.structuredContent).toMatchObject({
        phase: "verified_readback",
        effectState: "verified",
        verification: { status: "verified" },
        limitations: expect.arrayContaining([
          "This change is already confirmed. Morrow does not repeat a confirmed check.",
        ]),
      });
      expect(writeCommands).toBe(3);
      const operationEgress = await runtime.redactMcpEgress(dispatched, { operation_id: id }, { bound: false });
      expect(JSON.stringify(operationEgress)).not.toContain("Jane Doe");
      expect(JSON.stringify(operationEgress)).not.toContain("jane.doe@example.edu");
      expect(JSON.stringify(operationEgress)).toMatch(/learner_[\w-]+/);
    }, CASE_TIMEOUT_MS);

    it("plans a private Canvas Inbox message from a learner token and keeps it out of every public list", async () => {
      activeEditPermission = detailedEditPermission("canvas_inbox_messages");
      bridge?.updateBindings([binding("canvas_inbox_messages")]);
      await bindingsApplied();
      const rawConversation = await runtime.call("canvas_create_conversation", {
        recipients: ["9001"],
        body: "Raw recipient identifiers must stay outside the public Morrow surface.",
        _morrow: { source_binding_id: sourceBindingId },
      });
      expect(rawConversation).toMatchObject({
        isError: true,
        structuredContent: { data: { code: "tool_not_found" } },
      });
      const roster = await runtime.call("canvas_list_users_in_course_users", {
        course_id: "42",
        enrollment_type: ["student"],
        enrollment_state: ["active", "invited", "completed", "inactive"],
        morrow_max_pages: 50,
        _morrow: { source_binding_id: sourceBindingId },
      });
      const learnerToken = /learner_[A-Za-z0-9_-]+/.exec(JSON.stringify(roster))?.[0];
      expect(learnerToken).toBeTruthy();
      const [plannerClientTransport, plannerServerTransport] = InMemoryTransport.createLinkedPair();
      const plannerServer = serveStdio(() => createFullMorrowServer(morrow), { transport: plannerServerTransport });
      const plannerClient = new Client(
        { name: "morrow-canvas-inbox-public-planner", version: "1" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      let conversationPlan: JsonObject;
      let cancelledConversationPlan: JsonObject;
      let classicQuizPlan: JsonObject;
      try {
        await plannerClient.connect(plannerClientTransport);
        const names = (await plannerClient.listTools()).tools.map((tool) => tool.name);
        expect(names).toContain("morrow_plan_canvas_conversation");
        expect(names).toContain("morrow_plan_classic_quiz_description_image_alt_repair");
        expect(names).not.toContain("canvas_send_private_conversation");
        expect(names).not.toContain("canvas_create_conversation");
        expect(names).not.toContain("canvas_add_message");
        conversationPlan = await plannerClient.callTool({
          name: "morrow_plan_canvas_conversation",
          arguments: {
            action: "create",
            source_binding_id: sourceBindingId,
            course_id: 42,
            recipient_tokens: [learnerToken!],
            recipient_contexts: ["group_12_students"],
            subject: "Jane Doe private subject marker",
            body: "Jane Doe private body marker must not leave the Canvas Inbox review.",
            group_conversation: true,
          },
        }) as unknown as JsonObject;
        cancelledConversationPlan = await plannerClient.callTool({
          name: "morrow_plan_canvas_conversation",
          arguments: {
            action: "create",
            source_binding_id: sourceBindingId,
            course_id: 42,
            recipient_tokens: [learnerToken!],
            recipient_contexts: ["group_12_students"],
            subject: "Jane Doe cancelled subject marker",
            body: "Jane Doe cancelled body marker must not leave the Canvas Inbox review.",
            group_conversation: true,
          },
        }) as unknown as JsonObject;
        classicQuizPlan = await plannerClient.callTool({
          name: "morrow_plan_classic_quiz_description_image_alt_repair",
          arguments: {
            source_binding_id: sourceBindingId,
            course_id: "42",
            quiz_id: "77",
            expected_body_sha256: sha256Text(classicQuiz.description),
            image_index: 1,
            image_src_sha256: sha256Text("/courses/42/files/16"),
            alt_text: "Cell structure diagram",
            decorative: false,
          },
        }) as unknown as JsonObject;
      } finally {
        await plannerClient.close();
        await plannerServer.close();
      }
      expect(conversationPlan.isError, JSON.stringify(conversationPlan)).not.toBe(true);
      expect(cancelledConversationPlan.isError, JSON.stringify(cancelledConversationPlan)).not.toBe(true);
      expect(classicQuizPlan.isError, JSON.stringify(classicQuizPlan)).not.toBe(true);
      conversationId = operationId(conversationPlan);
      const cancelledConversationId = operationId(cancelledConversationPlan);
      const savedConversationPlan = runtime.effects.get(conversationId);
      expect(savedConversationPlan).toMatchObject({
        state: "approved",
        plan: {
          authorization: { kind: "edit_scope", policyDigest: "d".repeat(64), policyRevision: 1 },
          arguments: {
            course_id: 42,
            _morrow: {
              source_binding_id: sourceBindingId,
              canvas_conversation: {
                schema: "morrow.canvas-conversation.plan.v1",
                action: "create",
                recipient_tokens: [learnerToken],
                recipient_contexts: ["group_12_students"],
              },
            },
          },
        },
      });
      expect(JSON.stringify(savedConversationPlan.plan.arguments)).not.toContain('"9001"');
      const classicQuizPlanId = operationId(classicQuizPlan);
      const savedClassicQuizPlan = runtime.effects.get(classicQuizPlanId);
      expect(savedClassicQuizPlan).toMatchObject({
        state: "awaiting_approval",
        plan: { arguments: { course_id: "42", id: "77", _morrow: { canvas_content_guard: {
          kind: "classic_quiz_description_image_alt", course_id: "42", quiz_id: "77", image_index: 1,
        } } } },
      });
      expect(JSON.stringify(savedClassicQuizPlan.plan.arguments)).not.toContain(classicQuiz.description);
      runtime.cancelOperation(classicQuizPlanId);
      const [controlClientTransport, controlServerTransport] = InMemoryTransport.createLinkedPair();
      const controlServer = serveStdio(() => createFullMorrowServer(morrow), { transport: controlServerTransport });
      const controlClient = new Client(
        { name: "morrow-canvas-inbox-public-controls", version: "1" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      try {
        await controlClient.connect(controlClientTransport);
        const expectedConversationControl = {
          schema: "morrow.operation-control.v1",
          operationId: conversationId,
          state: "approved",
          dispatchAttempt: 0,
          verification: { status: "unconfirmed" },
          contentOmittedReason: "historical_learner_scope_unavailable",
        };
        const get = await controlClient.callTool({ name: "morrow_operation_get", arguments: { operation_id: conversationId } });
        expect(get.isError, JSON.stringify(get)).not.toBe(true);
        expect(get.structuredContent).toEqual(expectedConversationControl);

        const listed = await controlClient.callTool({ name: "morrow_operation_list", arguments: { limit: 50 } });
        expect(listed.isError, JSON.stringify(listed)).not.toBe(true);
        const listedOperations = (listed.structuredContent as { operations?: unknown }).operations;
        expect(Array.isArray(listedOperations)).toBe(true);
        expect(listedOperations).toContainEqual(expectedConversationControl);

        const recent = await controlClient.callTool({ name: "morrow_operations_recent", arguments: { limit: 50 } });
        expect(recent.isError, JSON.stringify(recent)).not.toBe(true);
        const recentOperations = (recent.structuredContent as { operations?: unknown }).operations;
        expect(Array.isArray(recentOperations)).toBe(true);
        // Recent lists only gateway journal records (`gop:`), never outer effect
        // records (`op:`). The private Inbox request must remain absent.
        expect(recentOperations).not.toContainEqual(expect.objectContaining({ operationId: conversationId }));

        const cancelled = await controlClient.callTool({ name: "morrow_operation_cancel", arguments: { operation_id: cancelledConversationId } });
        expect(cancelled.isError, JSON.stringify(cancelled)).not.toBe(true);
        expect((cancelled.structuredContent as { data?: unknown }).data).toEqual({
          ...expectedConversationControl,
          operationId: cancelledConversationId,
          state: "cancelled",
        });

        for (const result of [get, listed, recent, cancelled]) {
          const serialized = JSON.stringify(result);
          expect(serialized).not.toContain("Jane Doe");
          expect(serialized).not.toContain('"9001"');
          expect(serialized).not.toContain("private subject marker");
          expect(serialized).not.toContain("private body marker");
          expect(serialized).not.toContain("cancelled subject marker");
          expect(serialized).not.toContain("cancelled body marker");
        }
      } finally {
        await controlClient.close();
        await controlServer.close();
      }
      expect(runtime.effects.get(cancelledConversationId)).toMatchObject({ state: "cancelled", dispatchAttempt: 0 });
      const conversationDispatch = await runtime.dispatchOperation(conversationId);
      expect(conversationDispatch.structuredContent).toMatchObject({ effectState: "verified", verification: { status: "verified" } });
      expect(writeCommands).toBe(4);
    }, CASE_TIMEOUT_MS);

    it("keeps the private Inbox record readable after the course connection changes", async () => {
      bridge?.updateBindings([{
        ...binding(false),
        sourceBindingId: "canvas:other-account",
        origin: "https://other.instructure.com",
        principalFingerprint: "e".repeat(64),
        sessionGeneration: 2,
      }]);
      await bindingsApplied();
      const [historicalClientTransport, historicalServerTransport] = InMemoryTransport.createLinkedPair();
      const historicalServer = serveStdio(() => createFullMorrowServer(morrow), { transport: historicalServerTransport });
      const historicalClient = new Client(
        { name: "morrow-canvas-inbox-historical-controls", version: "1" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      try {
        await historicalClient.connect(historicalClientTransport);
        const expectedHistoricalControl = {
          schema: "morrow.operation-control.v1",
          operationId: conversationId,
          state: "verified",
          dispatchAttempt: 1,
          verification: { status: "verified" },
          contentOmittedReason: "historical_learner_scope_unavailable",
        };
        const get = await historicalClient.callTool({ name: "morrow_operation_get", arguments: { operation_id: conversationId } });
        expect(get.structuredContent).toEqual(expectedHistoricalControl);
        const listed = await historicalClient.callTool({ name: "morrow_operation_list", arguments: { limit: 50 } });
        const listedOperations = (listed.structuredContent as { operations?: unknown }).operations;
        expect(Array.isArray(listedOperations)).toBe(true);
        expect(listedOperations).toContainEqual(expectedHistoricalControl);
        for (const result of [get, listed]) {
          const serialized = JSON.stringify(result);
          expect(serialized).not.toContain("Jane Doe");
          expect(serialized).not.toContain('"9001"');
          expect(serialized).not.toContain("private subject marker");
          expect(serialized).not.toContain("private body marker");
        }
      } finally {
        await historicalClient.close();
        await historicalServer.close();
      }
      bridge?.updateBindings([binding("canvas_inbox_messages")]);
      await bindingsApplied();
    }, CASE_TIMEOUT_MS);

    it("refuses a plan with no course connection, and one whose course connection changed", async () => {
      const unbound = await runtime.call("canvas_add_course_to_favorites", {
        id: "43",
        _morrow: { operation_id: "operation:unbound-connector-test" },
      });
      expect(unbound).toMatchObject({ isError: true, structuredContent: { data: { code: "operation_plan_invalid" } } });

      const stalePlan = await runtime.call("canvas_add_course_to_favorites", {
        id: "42",
        _morrow: {
          operation_id: "operation:stale-binding-connector-test",
          source_binding_id: sourceBindingId,
        },
      });
      const staleId = operationId(stalePlan);
      bridge?.updateBindings([{
        ...binding(false),
        sourceBindingId: "canvas:other-account:g2",
        origin: "https://other.instructure.com",
        principalFingerprint: "e".repeat(64),
        sessionGeneration: 2,
      }]);
      await bindingsApplied();
      runtime.approveOperation(staleId);
      const staleDispatch = await runtime.dispatchOperation(staleId);
      expect(staleDispatch).toMatchObject({
        isError: true,
        structuredContent: { data: { code: "operation_dispatch_refused" } },
      });
      expect(runtime.effects.get(staleId)).toMatchObject({ state: "approved", dispatchAttempt: 0 });
      expect(writeCommands).toBe(4);
    }, CASE_TIMEOUT_MS);

    it("recovers an unresolved historical record after a restart", async () => {
      const request = { id: "42", _morrow: { source_binding_id: sourceBindingId } };
      const policy = {
        schema: "morrow.connector-readback-policy.v1",
        source: "canvas-session",
        tool: "canvas_add_course_to_favorites",
        sourceTool: "canvas_add_course_to_favorites",
        requestDigest: sha256Json(request),
      };
      const historical = runtime.effects.create({
        publicToolName: "canvas_add_course_to_favorites",
        sourceId: "canvas-session",
        sourceToolName: "canvas_add_course_to_favorites",
        catalogDigest: runtime.catalog.digest,
        request,
        forwardedRequest: request,
        sourceOperationId: "operation:embedded-readback-restart",
        authority: {
          profileDigest: "1".repeat(64),
          actorDigest: "2".repeat(64),
          providerPrincipalDigest: "3".repeat(64),
          connectionGeneration: 1,
          catalogDigest: runtime.catalog.digest,
          approvalClass: "standard",
          targetSetDigest: "4".repeat(64),
        },
        readback: {
          tool: "morrow_connector_embedded_readback",
          arguments: policy,
          expectedDigest: sha256Json(policy),
        },
      });
      runtime.effects.approve(historical.operationId);
      runtime.effects.reserveDispatch(historical.operationId);
      await morrow.close();
      await bridge?.close();
      morrow = await MorrowRuntime.connect(config, { statePath: join(directory, "gateway.sqlite3") });
      runtime = morrow.gateway;
      const recovered = await runtime.reconcileOperation(historical.operationId);
      expect(recovered.structuredContent).toMatchObject({
        phase: "reconciliation_requires_provider_evidence",
        effectState: "applied_or_unknown",
        receipts: { dispatchAttempt: 1 },
        limitations: expect.arrayContaining([
          "Morrow will not replay this operation because the provider effect may have occurred.",
          "Morrow did not keep a read-only check for this change, so it cannot check the result for you. Open the item in Canvas and see whether the change is there. If it is missing, ask Morrow for a new review; Morrow will not send this change again.",
        ]),
      });
      expect(runtime.effects.get(historical.operationId)).toMatchObject({
        state: "applied_or_unknown",
        dispatchAttempt: 1,
      });
      expect(writeCommands).toBe(4);
    }, CASE_TIMEOUT_MS);
  });

  it("runs a governed cross-course connector batch with one write per child", async () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-canvas-connector-batch-"));
    const port = await reserveLoopbackPort();
    const runtime = await MorrowRuntime.connect(connectorConfig(directory, port), {
      statePath: join(directory, "morrow.sqlite3"),
      batchKeyPath: join(directory, "batch.key"),
    });
    const extensionId = "a".repeat(32);
    const sourceBindingId = "canvas:test-account:g1";
    const browserCatalogDigest = bridgeCatalogDigestForTests(resolve("../.."));
    const courseBindingId = (courseId: string) => courseId === "42" ? sourceBindingId : `${sourceBindingId}:${courseId}`;
    const detailedEditPermission = {
      schema: "morrow.bridge.edit-permission.v1" as const,
      revision: 1,
      scopeDigest: "e".repeat(64),
      catalogDigest: browserCatalogDigest,
      sourceBindingId,
      enabledCategories: ["canvas_page_content"],
      rules: [{
        operationKey: "PUT /v1/courses/{course_id}/pages/{url_or_id}#update_create_page_courses",
        toolName: "canvas_update_create_page_courses",
        allowedChangedFields: [],
        requiresCanvasContentGuard: true,
        canvasContentGuardKind: "page_text",
      }],
    };
    const binding = (withEditPermission = false, courseId = "42") => ({
      sourceBindingId: courseBindingId(courseId),
      provider: "canvas" as const,
      origin: "https://school.instructure.com",
      courseId,
      principalFingerprint: "c".repeat(64),
      sessionGeneration: 1,
      catalogDigest: browserCatalogDigest,
      runtimeVerified: true,
      ...(withEditPermission ? {
        editPolicyRevision: detailedEditPermission.revision,
        editOptionsAvailable: true,
        editPermission: {
          schema: detailedEditPermission.schema,
          revision: detailedEditPermission.revision,
          scopeDigest: detailedEditPermission.scopeDigest,
          catalogDigest: detailedEditPermission.catalogDigest,
          sourceBindingId: detailedEditPermission.sourceBindingId,
        },
      } : {}),
    });
    let activeEditPermission: typeof detailedEditPermission | undefined;
    let bridge: BridgeTestClient | undefined;
    try {
      expect(await runtime.health()).toMatchObject({
        ready: false,
        components: {
          canvasConnector: { processConnected: true, ready: false },
          extensionBridge: { connected: false },
        },
      });
      await assertPortListening(port);
      bridge = await connectBridgeTestClient({
        port,
        token: "gateway-connector-secret-".repeat(3),
        extensionId,
        catalogDigest: browserCatalogDigest,
        bindings: [binding(false, "41"), binding(), binding(false, "43")],
      });
      expect(await runtime.health()).toMatchObject({
        ready: true,
        components: {
          canvasConnector: { processConnected: true, ready: true },
          extensionBridge: { connected: true, bindingCount: 3 },
        },
      });
      const receipts = new Set<string>();
      let writeCommands = 0;
      let confirmed = true;
      bridge.onCommand((command) => {
        if (command.kind === "edit_policy_options_get") {
          bridge?.respond(command, {
            schema: "morrow.bridge.edit-options.v1",
            sourceBindingId,
            provider: "canvas",
            catalogDigest: browserCatalogDigest,
            policyRevision: detailedEditPermission.revision,
            runtimeVerified: true,
            options: [],
            ...(activeEditPermission ? { editPermission: activeEditPermission } : {}),
          });
          return;
        }
        if (command.kind === "invoke_write") {
          writeCommands += 1;
          receipts.add(String(command.outerGrant?.effectReceiptId));
        } else {
          expect(command.toolName).toBe("canvas_get_single_course_courses");
        }
        const id = String(command.arguments?.id);
        bridge?.respond(command, {
          schema: "morrow.canvas-browser-result.v1",
          ok: true,
          sent: true,
          status: 200,
          data: { id, name: `Course ${id}` },
          verification: {
            schema: "morrow.browser-verification.v1",
            status: confirmed ? "verified" : "unconfirmed",
            strategy: "collection-contains-target",
            readTool: "canvas_list_favorite_courses",
            evidence: "fresh_readback_matches_requested_postcondition",
          },
        });
      });

      const created = await runtime.batchCreate({
        name: "Favorite two courses",
        mode: "stage_writes",
        concurrency: 1,
        courseSet: { source: "explicit", courseIds: ["41", "42"], complete: true },
        operations: ["41", "42"].map((courseId) => ({
          childId: `course:${courseId}`,
          courseId,
          tool: "canvas_add_course_to_favorites",
          sourceBindingId: courseBindingId(courseId),
          arguments: { id: courseId },
        })),
      });
      const batchId = String((created.batch as JsonObject).batchId);
      await approveBatch(String(created.approvalUrl));
      await expect.poll(() => runtime.batchGet({ batchId }).batch).toMatchObject({ state: "completed" });
      const operationGet = vi.spyOn(runtime.gateway, "operationGet");
      const status = runtime.batchApprovalStatus(batchId);
      expect(operationGet).not.toHaveBeenCalled();
      operationGet.mockRestore();
      expect(status).toMatchObject({
        confirmedChildren: 2,
        totalChildren: 2,
        states: { 0: "Confirmed in Canvas", 1: "Confirmed in Canvas" },
      });
      const result = runtime.batchGet({ batchId });
      expect(result.batch).toMatchObject({ state: "completed" });
      expect(result.sourceSettlement).toMatchObject({ outcome: "succeeded", succeeded: 2, terminal: true });
      expect(writeCommands).toBe(2);
      expect(receipts.size).toBe(2);
      const detail = runtime.batchResultsPage({ batchId, limit: 10 });
      expect(detail.children).toMatchObject([
        { childId: "course:41", state: "succeeded", gatewayOperationState: "verified" },
        { childId: "course:42", state: "succeeded", gatewayOperationState: "verified" },
      ]);
      const reconciled = await runtime.batchReconcile({ batchId, maxChildren: 10 });
      expect(reconciled.processed).toBe(0);
      expect(reconciled.sourceSettlement).toMatchObject({ outcome: "succeeded", succeeded: 2 });

      const oldReviewPlan = await runtime.gateway.call("canvas_update_create_page_courses", {
        course_id: "42",
        url_or_id: "reviewed-page",
        _morrow: {
          source_binding_id: sourceBindingId,
          page_guard: {
            page_id: "92", revision_id: "1", body_sha256: "b".repeat(64),
            fields: { url: "reviewed-page", title: "Reviewed page", published: true, front_page: false, editing_roles: "teachers", publish_at: null },
            kind: "text", find_text: "old", replace_text: "new",
          },
        },
      });
      const oldReviewId = operationId(oldReviewPlan);
      expect(oldReviewPlan.structuredContent).toMatchObject({ effectState: "awaiting_approval", status: "awaiting_approval" });
      expect(writeCommands).toBe(2);

      activeEditPermission = detailedEditPermission;
      bridge?.updateBindings([binding(false, "41"), binding(true), binding(false, "43")]);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      const oldReviewDispatch = await runtime.gateway.dispatchOperation(oldReviewId);
      expect(oldReviewDispatch.isError).toBe(true);
      expect(runtime.gateway.effects.get(oldReviewId)).toMatchObject({ state: "awaiting_approval", plan: { authorization: { kind: "review" } } });
      expect(writeCommands).toBe(2);
      const guard = { kind: "page_text", course_id: "42", page_id: "91", revision_id: "1", body_sha256: "a".repeat(64), fields: { url: "lesson", title: "Lesson", published: true, front_page: false, editing_roles: "teachers", publish_at: null }, find_text: "old", replace_text: "new" };
      const editBatch = await runtime.batchCreate({
        name: "Update two guarded pages", mode: "stage_writes", concurrency: 1,
        courseSet: { source: "explicit", courseIds: ["42"], complete: true },
        operations: ["lesson-a", "lesson-b"].map((url) => ({
          childId: `page:${url}`, courseId: "42", tool: "canvas_update_create_page_courses", sourceBindingId,
          arguments: { course_id: "42", url_or_id: url, _morrow: { canvas_content_guard: { ...guard, fields: { ...guard.fields, url } } } },
        })),
      });
      expect(editBatch).not.toHaveProperty("approvalUrl");
      const editBatchId = String((editBatch.batch as JsonObject).batchId);
      await runtime.batchRun({ batchId: editBatchId, maxChildren: 2 });
      expect(runtime.batchGet({ batchId: editBatchId }).batch).toMatchObject({ state: "completed" });
      expect(writeCommands).toBe(4);

      const mixed = await runtime.batchCreate({
        name: "Review a mixed Page and course change", mode: "stage_writes", concurrency: 1,
        courseSet: { source: "explicit", courseIds: ["42"], complete: true },
        operations: [
          {
            childId: "page:mixed", courseId: "42", tool: "canvas_update_create_page_courses", sourceBindingId,
            arguments: { course_id: "42", url_or_id: "mixed-page", _morrow: { canvas_content_guard: { ...guard, page_id: "93", fields: { ...guard.fields, url: "mixed-page" } } } },
          },
          { childId: "course:42", courseId: "42", tool: "canvas_add_course_to_favorites", sourceBindingId, arguments: { id: "42" } },
        ],
      });
      const mixedId = String((mixed.batch as JsonObject).batchId);
      expect(mixed.approvalUrl).toBeTruthy();
      expect(runtime.batchGet({ batchId: mixedId }).batch).toMatchObject({ state: "planned", pendingChildren: 2 });
      expect(writeCommands).toBe(4);

      confirmed = false;
      const uncertain = await runtime.batchCreate({
        name: "Stop after an unconfirmed result", mode: "stage_writes", concurrency: 1,
        courseSet: { source: "explicit", courseIds: ["41", "42"], complete: true },
        operations: ["41", "42"].map((courseId) => ({
          childId: `course:${courseId}`, courseId, tool: "canvas_add_course_to_favorites",
          sourceBindingId: courseBindingId(courseId), arguments: { id: courseId },
        })),
      });
      const uncertainId = String((uncertain.batch as JsonObject).batchId);
      const uncertainUrl = String(uncertain.approvalUrl);
      await approveBatch(uncertainUrl);
      await expect.poll(async () => (await (await fetch(`${uncertainUrl}/status`)).json()).active).toBe(false);
      expect(runtime.batchGet({ batchId: uncertainId }).batch).toMatchObject({ state: "paused", pendingChildren: 1 });
      const uncertainView = await (await fetch(uncertainUrl)).text();
      expect(uncertainView).toContain("0 of 2 changes confirmed in Canvas");
      expect(uncertainView).toContain("<span data-operation-status>Needs checking</span>");
      expect(uncertainView).toContain("<span data-operation-status>Not started</span>");
      expect(uncertainView).not.toContain("Changes confirmed");
      expect(writeCommands).toBe(5);

      const queued = await runtime.batchCreate({
        name: "Do not start queued work during shutdown", mode: "stage_writes", concurrency: 1,
        courseSet: { source: "explicit", courseIds: ["43"], complete: true },
        operations: [{ childId: "course:43", courseId: "43", tool: "canvas_add_course_to_favorites",
          sourceBindingId: courseBindingId("43"), arguments: { id: "43" } }],
      });
      const queuedId = String((queued.batch as JsonObject).batchId);
      runtime.approveBatch(queuedId);
      let releaseWindow!: () => void;
      const heldWindow = runtime.batchScheduler.run("hold-window", () => new Promise<void>((resolve) => {
        releaseWindow = resolve;
      }));
      await expect.poll(() => runtime.batchScheduler.health().activeWindows).toBe(1);
      const shutdown = new AbortController();
      const queuedWork = runtime.runApprovedBatch(queuedId, shutdown.signal);
      await expect.poll(() => runtime.batchScheduler.health().waitingWindows).toBe(1);
      shutdown.abort();
      releaseWindow();
      await Promise.all([heldWindow, queuedWork]);
      expect(writeCommands).toBe(5);
      expect(runtime.batchGet({ batchId: queuedId }).batch).toMatchObject({ state: "paused", pendingChildren: 1 });
    } finally {
      await bridge?.close();
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, CASE_TIMEOUT_MS);

  it("settles a refused Canvas page write as failed, locks the page after an uncertain one, and releases it only on a person-confirmed close-out", async () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-canvas-write-outcome-"));
    const port = await reserveLoopbackPort();
    const root = resolve("../..");
    const morrow = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath: join(directory, "gateway.sqlite3") });
    const runtime = morrow.gateway;
    const extensionId = "a".repeat(32);
    const sourceBindingId = "canvas:write-outcome-account";
    const browserCatalogDigest = bridgeCatalogDigestForTests(root);
    const editPermission = {
      schema: "morrow.bridge.edit-permission.v1" as const,
      revision: 1,
      scopeDigest: "d".repeat(64),
      catalogDigest: browserCatalogDigest,
      sourceBindingId,
      enabledCategories: ["canvas_page_content"],
      rules: [{
        operationKey: "PUT /v1/courses/{course_id}/pages/{url_or_id}#update_create_page_courses",
        toolName: "canvas_update_create_page_courses",
        allowedChangedFields: [],
        requiresCanvasContentGuard: true,
        canvasContentGuardKind: "page_text",
      }],
    };
    let bridge: BridgeTestClient | undefined;
    const lesson = {
      page_id: "91", url: "lesson", title: "Cell structure",
      body: "<h2>Cell structure</h2><p>Cells have membranes.</p>",
      published: true, front_page: false, editing_roles: "teachers", publish_at: null,
    };
    let revision = 1;
    // The exact ending the Bridge reports for the next write. The extension
    // chooses the problem code with the one status-class rule in
    // connector/extension/src/canvas-write-outcome.js, which
    // scripts/test/canvas-write-outcome-class.test.mjs executes for every
    // status: HTTP 422 is a refusal Canvas never saved, HTTP 502 may already be
    // saved.
    let nextWrite: "saved" | 422 | 502 = "saved";
    let writeCommands = 0;

    try {
      await assertPortListening(port);
      bridge = await connectBridgeTestClient({
        port,
        token: "gateway-connector-secret-".repeat(3),
        extensionId,
        catalogDigest: browserCatalogDigest,
        bindings: [{
          sourceBindingId,
          provider: "canvas" as const,
          origin: "https://school.instructure.com",
          courseId: "42",
          principalFingerprint: "c".repeat(64),
          sessionGeneration: 1,
          catalogDigest: browserCatalogDigest,
          runtimeVerified: true,
          editPolicyRevision: editPermission.revision,
          editOptionsAvailable: true,
          // A binding carries the permission summary; the rules arrive with the
          // edit options below, exactly as the extension sends them.
          editPermission: {
            schema: editPermission.schema,
            revision: editPermission.revision,
            scopeDigest: editPermission.scopeDigest,
            catalogDigest: editPermission.catalogDigest,
            sourceBindingId: editPermission.sourceBindingId,
          },
        }],
      });

      bridge.onCommand((command) => {
        if (command.kind === "edit_policy_options_get") {
          bridge?.respond(command, {
            schema: "morrow.bridge.edit-options.v1",
            sourceBindingId,
            provider: "canvas",
            catalogDigest: browserCatalogDigest,
            policyRevision: 1,
            runtimeVerified: true,
            options: [],
            editPermission,
          });
          return;
        }
        if (command.kind === "invoke_write") {
          writeCommands += 1;
          if (nextWrite !== "saved") {
            const refused = nextWrite === 422;
            nextWrite = "saved";
            bridge?.respondProblem(command, {
              schema: "morrow.bridge.problem.v1",
              code: refused ? "canvas_request_not_sent" : "write_outcome_unknown",
              message: refused
                ? "Canvas did not accept this change, so nothing was saved."
                : "Canvas did not answer this change, so it may have been saved.",
              recoverable: refused,
            });
            return;
          }
          revision += 1;
          lesson.body = "<h2>Cell structure</h2><p>Cells have protective membranes.</p>";
        }
        bridge?.respond(command, {
          schema: "morrow.canvas-browser-result.v1",
          ok: true,
          sent: true,
          status: 200,
          truncated: false,
          ...(command.toolName === "canvas_show_page_courses" ? { pageBodySha256: sha256Text(lesson.body) } : {}),
          data: command.toolName === "canvas_show_revision_courses_latest"
            ? { revision_id: String(revision), latest: true, url: lesson.url, title: lesson.title, body: lesson.body }
            : command.toolName === "canvas_show_page_courses"
              ? lesson
              // The public read path establishes its learner privacy boundary
              // from the roster before it returns anything.
              : command.toolName === "canvas_list_users_in_course_users"
                ? [{ id: "9001", name: "Jane Doe", email: "jane.doe@example.edu", login_id: "jdoe" }]
                : { id: "42", name: "Biology" },
          ...(command.kind === "invoke_write" ? {
            verification: {
              schema: "morrow.browser-verification.v1",
              status: "verified",
              strategy: "page-text",
              readTool: "canvas_show_page_courses",
              evidence: "fresh_readback_matches_requested_postcondition",
            },
          } : {}),
        });
      });

      const correction = async (findText: string, replaceText: string) => {
        const planned = await planPageCorrection(runtime, {
          source_binding_id: sourceBindingId, course_id: "42", page_url: "lesson",
          find_text: findText, replace_text: replaceText,
        });
        expect(planned.isError, JSON.stringify(planned)).not.toBe(true);
        return operationId(planned as unknown as JsonObject);
      };

      // Canvas refused the change: the record is failed, and the page is not
      // locked by a change that never happened.
      nextWrite = 422;
      const refusedId = await correction("Cells have membranes.", "Cells have protective membranes.");
      const refused = await runtime.dispatchOperation(refusedId);
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({ effectState: "failed" });
      expect(runtime.effects.get(refusedId)).toMatchObject({ state: "failed", dispatchAttempt: 1 });
      expect(writeCommands).toBe(1);

      const savedId = await correction("Cells have membranes.", "Cells have protective membranes.");
      const saved = await runtime.dispatchOperation(savedId);
      expect(saved.isError, JSON.stringify(saved)).not.toBe(true);
      expect(saved.structuredContent).toMatchObject({ effectState: "verified", verification: { status: "verified" } });
      expect(writeCommands).toBe(2);

      // Canvas may have saved the change: the record stays unresolved and the
      // page is locked until that record is settled.
      nextWrite = 502;
      const uncertainId = await correction("Cells have protective membranes.", "Cells have cell membranes.");
      const uncertain = await runtime.dispatchOperation(uncertainId);
      expect(uncertain.isError).toBe(true);
      expect(uncertain.structuredContent).toMatchObject({ effectState: "applied_or_unknown" });
      expect(runtime.effects.get(uncertainId)).toMatchObject({ state: "applied_or_unknown", dispatchAttempt: 1 });
      expect(writeCommands).toBe(3);

      // The refusal names the request that holds the page, so the person knows
      // exactly which saved request to resolve.
      const blockedId = await correction("Cells have protective membranes.", "Cells have thin membranes.");
      const blocked = await runtime.dispatchOperation(blockedId);
      expect(blocked.isError).toBe(true);
      expect(blocked.structuredContent).toMatchObject({
        data: { reason: "provider_effect_target_conflict", blockingOperationId: uncertainId },
      });
      expect(JSON.stringify(blocked.content)).toContain(uncertainId);
      expect(runtime.effects.get(blockedId)).toMatchObject({ state: "approved", dispatchAttempt: 0 });
      expect(writeCommands).toBe(3);

      // The 502 left no read-only comparator, so Morrow cannot check this change
      // for itself.
      const unresolvable = await runtime.reconcileOperation(uncertainId);
      expect(unresolvable.structuredContent).toMatchObject({
        phase: "reconciliation_requires_provider_evidence",
        effectState: "applied_or_unknown",
      });

      // A close-out needs a person's confirmation and the exact digest of a
      // fresh Morrow read. Neither half alone closes anything.
      const withoutPerson = runtime.closeUnresolvedOperation(uncertainId, "b".repeat(64), false);
      expect(withoutPerson.isError).toBe(true);
      expect(withoutPerson.structuredContent).toMatchObject({ data: { code: "person_confirmation_required" } });
      const withoutRead = runtime.closeUnresolvedOperation(uncertainId, "b".repeat(64), true);
      expect(withoutRead.isError).toBe(true);
      expect(withoutRead.structuredContent).toMatchObject({ data: { code: "observed_state_not_from_fresh_read" } });
      expect(runtime.effects.get(uncertainId).state).toBe("applied_or_unknown");

      const freshRead = await runtime.call("canvas_show_page_courses", {
        course_id: "42",
        url_or_id: "lesson",
        _morrow: { source_binding_id: sourceBindingId },
      });
      expect(freshRead.isError, JSON.stringify(freshRead)).not.toBe(true);
      const observedState = ((freshRead._meta as JsonObject)["io.morrow/gateway"] as JsonObject).upstreamResultSha256;
      expect(observedState).toMatch(/^[0-9a-f]{64}$/);

      const closed = runtime.closeUnresolvedOperation(uncertainId, String(observedState), true);
      expect(closed.isError, JSON.stringify(closed)).not.toBe(true);
      expect(closed.structuredContent).toMatchObject({
        effectState: "closed_by_person",
        verification: { status: "unconfirmed" },
        attention: ["closed_after_person_checked_saved_state"],
        limitations: expect.arrayContaining([
          "Morrow did not check this change itself. It is closed because a person read the item and confirmed the saved state.",
        ]),
        data: { schema: "morrow.operation-person-close.v1", readTool: "canvas_show_page_courses", resentWrite: false },
      });
      expect(runtime.effects.get(uncertainId)).toMatchObject({
        state: "closed_by_person",
        verificationStatus: "unconfirmed",
        personObservedStateDigest: observedState,
      });
      // Closing sends nothing.
      expect(writeCommands).toBe(3);

      // A settled record is not described as one Morrow failed to check.
      const afterClose = await runtime.reconcileOperation(uncertainId);
      expect(afterClose.structuredContent).toMatchObject({
        phase: "closed_by_person",
        effectState: "closed_by_person",
        limitations: [
          "Morrow did not check this change itself. It is closed because a person read the item and confirmed the saved state.",
        ],
      });

      // With the page no longer held, the refused change can be sent.
      const released = await runtime.dispatchOperation(blockedId);
      expect(released.isError, JSON.stringify(released)).not.toBe(true);
      expect(released.structuredContent).toMatchObject({ effectState: "verified" });
      expect(writeCommands).toBe(4);
    } finally {
      await bridge?.close();
      await morrow.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, CASE_TIMEOUT_MS);
});
