import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { describe, expect, it } from "vitest";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import { collectCanvasProgramInventory, collectCourseInventoryTool, registerCourseInventoryTool } from "../src/course-inventory.js";
import type { GatewayRuntime } from "../src/runtime.js";

const selection = {
  provider: "canvas" as const,
  scope: "selected_program" as const,
  courses: [{ course_id: "42", expected_name: "Biology", source_binding_id: "canvas-course-42" }],
};

type SnapshotMap = Record<string, unknown>;

function sourceResult(data: unknown, truncated = false, resume: JsonObject = {}): JsonObject {
  return {
    structuredContent: {
      schema: "morrow.canvas-connector.result.v1",
      ok: true,
      commandKind: "invoke_read",
      result: { ok: true, sent: true, data, truncated, pageCount: 1, ...resume },
    },
  };
}

/**
 * The connector side of a bounded list resume: every capped page hands back one
 * opaque token, and the next call must send that exact token back. `unreadPages`
 * is what Canvas states through its Link header rel="last".
 */
interface PaginatedList {
  readonly tool: string;
  readonly pages: readonly (readonly JsonObject[])[];
  readonly unreadPages?: number;
  /** The connector refuses the resume instead of continuing, as a rejected token does. */
  readonly refuseResume?: boolean;
  /** Canvas never runs out of pages, so only a Morrow bound can stop the list. */
  readonly endless?: boolean;
}

function resumeToken(argumentsValue: JsonObject): string | undefined {
  const routing = argumentsValue._morrow;
  if (!isJsonObject(routing) || !isJsonObject(routing.list_resume)) return undefined;
  const next = routing.list_resume.next_page;
  return typeof next === "string" ? next : undefined;
}

function paginatedResult(list: PaginatedList, argumentsValue: JsonObject): JsonObject {
  const token = resumeToken(argumentsValue);
  const index = token === undefined ? 0 : Number(token.replace("morrowpage-", ""));
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("inventory sent an unusable resume token");
  const page = list.endless ? list.pages[index % list.pages.length]! : list.pages[index];
  if (!page) throw new Error("inventory resumed past the end of the fixture list");
  const last = !list.endless && index === list.pages.length - 1;
  return sourceResult(page, !last, last ? {} : {
    morrow_next_page: `morrowpage-${index + 1}`,
    ...(list.unreadPages === undefined ? {} : { morrow_unread_pages: list.unreadPages }),
  });
}

function fixture(options: {
  readonly truncatedTool?: string;
  readonly truncatedAnnouncements?: boolean;
  readonly missingTool?: string;
  readonly course?: JsonObject;
  readonly pages?: readonly JsonObject[];
  readonly shares?: readonly JsonObject[];
  readonly paginated?: PaginatedList;
} = {}) {
  const calls: { name: string; arguments: JsonObject }[] = [];
  const snapshots: SnapshotMap = {
    canvas_get_single_course_courses: options.course ?? { id: "42", name: "Biology", syllabus_body: "<h1>Syllabus</h1>" },
    canvas_list_modules: [{ id: "7", name: "Orientation" }],
    canvas_list_module_items: [{ id: "71", type: "ExternalUrl", title: "Publisher simulation" }],
    canvas_list_pages_courses: options.pages ?? [{ page_id: "11", url: "welcome", title: "Welcome" }, { page_id: "22", url: "lab-safety", title: "Lab safety" }],
    canvas_show_front_page_courses: { page_id: "11", url: "welcome", title: "Welcome", front_page: true },
    canvas_list_assignments_assignments: [{ id: "12", name: "Reflection" }],
    canvas_list_discussion_topics_courses: [{ id: "13", title: "Introductions", is_announcement: false }],
    canvas_list_discussion_topics_courses_announcements: [{ id: "23", title: "Week one notes", is_announcement: true }],
    canvas_list_rubrics_courses: [{ id: "24", title: "Lab report rubric" }],
    canvas_list_quizzes_in_course: [{ id: "14", title: "Classic check" }],
    canvas_list_questions_in_quiz_or_submission: [{ id: "15", question_name: "Cell question" }],
    canvas_list_new_quizzes: [{ id: "16", title: "New quiz" }],
    canvas_list_quiz_items: [{ id: "17", entry_type: "Stimulus", entry: { title: "Cell diagram" } }],
    canvas_list_files_courses: [{ id: "18", display_name: "Reference.pdf" }],
    canvas_item_bank_list_banks: [{ id: "19", title: "Shared bank" }],
    canvas_item_bank_list_shares: options.shares ?? [],
    canvas_item_bank_list_entries: [{ id: "20", entry_type: "BankEntry", entry: { title: "Shared question" } }],
  };
  const runtime = {
    catalog: { tools: [] },
    config: { upstreams: [{ id: "canvas", outputPrivacy: {}, outputPrivacyDefault: { fieldPolicy: "scrub-sensitive", freeText: "allow", aiClientAdmission: "allow" } }] },
    searchCatalog: ({ query }: { query?: string }) => ({
      tools: query === options.missingTool ? [] : [{ publicName: query!, upstreamName: query!, upstreamId: "canvas", annotations: { readOnlyHint: true } }],
    }),
    capabilityGet: (name: string) => ({ descriptor: {
      provider: "canvas",
      route: { backend: "canvas-connector" },
      sourceImplementations: [{ toolName: name }],
    } }),
    callSourceOwned: async (name: string, argumentsValue: JsonObject) => {
      calls.push({ name, arguments: argumentsValue });
      const announcements = name === "canvas_list_discussion_topics_courses" && argumentsValue.only_announcements === true;
      const key = announcements ? "canvas_list_discussion_topics_courses_announcements" : name;
      if (!Object.hasOwn(snapshots, key)) throw new Error(`unexpected inventory read ${name}`);
      if (options.paginated && name === options.paginated.tool && !announcements) {
        if (options.paginated.refuseResume && resumeToken(argumentsValue) !== undefined) {
          return { isError: true, structuredContent: { schema: "morrow.problem.v1", code: "canvas_pagination_resume_refused" } };
        }
        return paginatedResult(options.paginated, argumentsValue);
      }
      return sourceResult(snapshots[key], announcements ? options.truncatedAnnouncements === true : name === options.truncatedTool);
    },
  } as unknown as GatewayRuntime;
  return { runtime, calls };
}

function object(value: unknown): JsonObject {
  expect(isJsonObject(value)).toBe(true);
  return value as JsonObject;
}

/** The one Item Bank entry target of a fixture course, with its discovery evidence. */
function itemBankEntry(course: JsonObject): JsonObject {
  const entries = (course.targets as JsonObject[]).filter((target) => object(target.target).kind === "item_bank_entry");
  expect(entries).toHaveLength(1);
  return object(entries[0]);
}

describe("Canvas course inventory", () => {
  it("discovers exact supported targets and emits a batch-ready manifest only after complete lists", async () => {
    const { runtime, calls } = fixture();
    const report = object(await collectCanvasProgramInventory(runtime, selection));
    expect(report).toMatchObject({
      schema: "morrow.course-inventory.v1",
      coverage: { status: "supported_inventory_complete", complete: true, pagination_complete: true, source: "explicit" },
    });
    const courses = report.courses as JsonObject[];
    expect(courses).toHaveLength(1);
    expect(courses[0]).toMatchObject({ course_id: "42", expected_name: "Biology", source_binding_id: "canvas-course-42", status: "inventory_complete" });
    const targets = object(courses[0]!).targets as JsonObject[];
    expect(targets.map((item) => object(item.target).kind)).toEqual(expect.arrayContaining([
      "page", "syllabus", "assignment", "discussion", "rubric", "classic_quiz", "classic_quiz_question", "new_quiz", "new_quiz_item", "file", "item_bank_entry",
    ]));
    expect(targets.find((item) => object(item.target).kind === "syllabus")).toMatchObject({
      target: { kind: "syllabus" },
      source_list: "course",
      batch_eligibility: "eligible",
      inventory_state: "discovered",
      discovery: { upstream_read_tool: "canvas_get_single_course_courses", listed_id: "42", title: "Biology", syllabus_body_returned: true },
    });
    expect(targets.find((item) => object(item.target).kind === "rubric")).toMatchObject({
      target: { kind: "rubric", rubric_id: "24" },
      source_list: "rubrics",
      batch_eligibility: "eligible",
      discovery: { upstream_read_tool: "canvas_list_rubrics_courses", title: "Lab report rubric", learner_assessment_data: "never_requested" },
    });
    const announcement = targets.find((item) => item.source_list === "announcements");
    expect(announcement).toMatchObject({
      target: { kind: "discussion", topic_id: "23" },
      batch_eligibility: "eligible",
      discovery: { upstream_read_tool: "canvas_list_discussion_topics_courses", title: "Week one notes", is_announcement: true },
    });
    expect(targets.filter((item) => object(item.target).kind === "page")).toEqual([
      expect.objectContaining({ target: { kind: "page", page_url: "welcome" }, discovery: expect.objectContaining({ front_page: true }) }),
      expect.objectContaining({ target: { kind: "page", page_url: "lab-safety" }, discovery: expect.objectContaining({ front_page: false }) }),
    ]);
    const lists = object(courses[0]!).lists as JsonObject[];
    expect(lists).toEqual(expect.arrayContaining([
      expect.objectContaining({ list: "discussions", upstream_read_tool: "canvas_list_discussion_topics_courses", status: "observed", truncated: false }),
      expect.objectContaining({ list: "announcements", upstream_read_tool: "canvas_list_discussion_topics_courses", status: "observed", truncated: false }),
      expect.objectContaining({ list: "rubrics", upstream_read_tool: "canvas_list_rubrics_courses", status: "observed", truncated: false }),
    ]));
    expect(targets.find((item) => object(item.target).kind === "new_quiz_item")).toMatchObject({
      source_binding_id: "canvas-course-42",
      discovery: { entry_type: "Stimulus" },
      batch_eligibility: "eligible",
    });
    expect(courses[0]!.coverage_gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "module_item_without_supported_audit_route", blocking: false }),
    ]));
    const children = report.audit_children as JsonObject[];
    expect(children).toHaveLength(targets.length);
    for (const childValue of children) {
      const child = object(childValue);
      const argumentsValue = object(child.arguments);
      expect(child).toMatchObject({ tool: "morrow_audit_course", courseId: "42", sourceBindingId: "canvas-course-42" });
      expect(argumentsValue).toMatchObject({ provider: "canvas", course_id: "42", source_binding_id: "canvas-course-42" });
      expect(argumentsValue).not.toHaveProperty("_morrow");
    }
    expect(calls.map((call) => call.name)).toEqual(expect.arrayContaining([
      "canvas_list_modules", "canvas_list_module_items", "canvas_list_pages_courses", "canvas_list_assignments_assignments",
      "canvas_list_discussion_topics_courses", "canvas_list_quizzes_in_course", "canvas_list_questions_in_quiz_or_submission",
      "canvas_list_new_quizzes", "canvas_list_quiz_items", "canvas_list_files_courses", "canvas_list_rubrics_courses",
      "canvas_show_front_page_courses", "canvas_item_bank_list_banks", "canvas_item_bank_list_shares", "canvas_item_bank_list_entries",
    ]));
    expect(calls.find((call) => call.name === "canvas_get_single_course_courses")?.arguments).toMatchObject({ id: "42", include: ["syllabus_body"] });
    const discussionCalls = calls.filter((call) => call.name === "canvas_list_discussion_topics_courses");
    expect(discussionCalls).toHaveLength(2);
    expect(discussionCalls[0]!.arguments).not.toHaveProperty("only_announcements");
    expect(discussionCalls[1]!.arguments).toMatchObject({ course_id: "42", only_announcements: true });
    expect(calls.every((call) => object(call.arguments._morrow).source_binding_id === "canvas-course-42")).toBe(true);
  });

  it("audits what a capped list returned when the connector offers no resume token", async () => {
    const { runtime } = fixture({ truncatedTool: "canvas_list_pages_courses" });
    const report = object(await collectCanvasProgramInventory(runtime, selection));
    expect(report).toMatchObject({
      coverage: {
        status: "inventory_incomplete",
        complete: false,
        pagination_complete: false,
        truncated_list_calls: 1,
        unread_page_responses: 1,
        unread_pages: "unknown",
        resume_available: false,
      },
    });
    const course = (report.courses as JsonObject[])[0]!;
    expect(course).toMatchObject({ status: "inventory_incomplete" });
    expect(course.coverage_gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "list_truncated_no_resume_token", list: "pages", blocking: true }),
    ]));
    expect(course.lists).toEqual(expect.arrayContaining([
      expect.objectContaining({ list: "pages", status: "truncated", truncated: true, list_calls: 1, unread_pages: "unknown", resume_available: false }),
    ]));
    const pages = (course.targets as JsonObject[]).filter((target) => object(target.target).kind === "page");
    expect(pages).toHaveLength(2);
    expect(pages.every((target) => target.batch_eligibility === "eligible" && target.inventory_state === "discovered_from_incomplete_list")).toBe(true);
    const pageChildren = (report.audit_children as JsonObject[])
      .filter((child) => object(object(child).arguments.target).kind === "page");
    expect(pageChildren).toHaveLength(2);
  });

  it("resumes one capped list to the end and claims completeness only then", async () => {
    const { runtime, calls } = fixture({
      paginated: {
        tool: "canvas_list_pages_courses",
        pages: [
          [{ page_id: "11", url: "welcome", title: "Welcome" }],
          [{ page_id: "22", url: "lab-safety", title: "Lab safety" }],
          [{ page_id: "33", url: "field-work", title: "Field work" }],
        ],
      },
    });
    const report = object(await collectCanvasProgramInventory(runtime, selection));
    expect(report).toMatchObject({
      coverage: {
        status: "supported_inventory_complete",
        complete: true,
        pagination_complete: true,
        truncated_list_calls: 2,
        unread_page_responses: 0,
        unread_pages: 0,
        resume_available: false,
      },
    });
    const course = (report.courses as JsonObject[])[0]!;
    expect(course).toMatchObject({ status: "inventory_complete" });
    expect(course.lists).toEqual(expect.arrayContaining([
      expect.objectContaining({ list: "pages", status: "observed", truncated: false, list_calls: 3, page_count: 3, unread_pages: 0, resume_available: false }),
    ]));
    const pageTargets = (course.targets as JsonObject[]).filter((target) => object(target.target).kind === "page");
    expect(pageTargets.map((target) => object(target.target).page_url)).toEqual(["welcome", "lab-safety", "field-work"]);
    expect(pageTargets.every((target) => target.batch_eligibility === "eligible" && target.inventory_state === "discovered")).toBe(true);
    expect((report.audit_children as JsonObject[]).filter((child) => object(object(child).arguments.target).kind === "page")).toHaveLength(3);

    const pageCalls = calls.filter((call) => call.name === "canvas_list_pages_courses");
    expect(pageCalls).toHaveLength(3);
    expect(object(pageCalls[0]!.arguments._morrow).list_resume).toEqual({});
    expect(object(pageCalls[1]!.arguments._morrow).list_resume).toEqual({ next_page: "morrowpage-1" });
    expect(object(pageCalls[2]!.arguments._morrow).list_resume).toEqual({ next_page: "morrowpage-2" });
    // The resume token is connector state. It never reaches the model.
    expect(JSON.stringify(report)).not.toContain("morrowpage-");
  });

  it("keeps every record it read auditable and states the exact unread pages when the resume bound is reached", async () => {
    const { runtime, calls } = fixture({
      paginated: {
        tool: "canvas_list_pages_courses",
        endless: true,
        unreadPages: 7,
        pages: [
          [{ page_id: "11", url: "welcome", title: "Welcome" }],
          [{ page_id: "22", url: "lab-safety", title: "Lab safety" }],
        ],
      },
    });
    const report = object(await collectCanvasProgramInventory(runtime, selection));
    expect(report).toMatchObject({
      coverage: {
        status: "inventory_incomplete",
        complete: false,
        pagination_complete: false,
        unread_page_responses: 1,
        unread_pages: 7,
        resume_available: true,
      },
    });
    const course = (report.courses as JsonObject[])[0]!;
    expect(course).toMatchObject({ status: "inventory_incomplete" });
    expect(calls.filter((call) => call.name === "canvas_list_pages_courses")).toHaveLength(8);
    expect(course.lists).toEqual(expect.arrayContaining([
      expect.objectContaining({ list: "pages", status: "truncated", truncated: true, list_calls: 8, unread_pages: 7, resume_available: true }),
    ]));
    expect(course.coverage_gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "list_resume_bound_reached", list: "pages", blocking: true }),
    ]));
    const pageTargets = (course.targets as JsonObject[]).filter((target) => object(target.target).kind === "page");
    expect(pageTargets.map((target) => object(target.target).page_url)).toEqual(["welcome", "lab-safety"]);
    expect(pageTargets.every((target) => target.batch_eligibility === "eligible" && target.inventory_state === "discovered_from_incomplete_list")).toBe(true);
    expect((report.audit_children as JsonObject[]).filter((child) => object(object(child).arguments.target).kind === "page")).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain("morrowpage-");
  });

  it("keeps the pages it already read when the connector refuses a resume token", async () => {
    const { runtime, calls } = fixture({
      paginated: {
        tool: "canvas_list_pages_courses",
        refuseResume: true,
        pages: [
          [{ page_id: "11", url: "welcome", title: "Welcome" }],
          [{ page_id: "22", url: "lab-safety", title: "Lab safety" }],
        ],
      },
    });
    const report = object(await collectCanvasProgramInventory(runtime, selection));
    expect(report).toMatchObject({ coverage: { status: "inventory_incomplete", complete: false, pagination_complete: false } });
    expect(calls.filter((call) => call.name === "canvas_list_pages_courses")).toHaveLength(2);
    const course = (report.courses as JsonObject[])[0]!;
    expect(course.coverage_gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "list_unavailable", list: "pages", blocking: true }),
    ]));
    expect(course.lists).toEqual(expect.arrayContaining([
      expect.objectContaining({ list: "pages", status: "truncated", truncated: true, list_calls: 2, resume_available: false }),
    ]));
    const pageTargets = (course.targets as JsonObject[]).filter((target) => object(target.target).kind === "page");
    expect(pageTargets.map((target) => object(target.target).page_url)).toEqual(["welcome"]);
    expect(pageTargets.every((target) => target.batch_eligibility === "eligible")).toBe(true);
    expect((report.audit_children as JsonObject[]).filter((child) => object(object(child).arguments.target).kind === "page")).toHaveLength(1);
  });

  it("keeps known exact targets auditable when a different required list route is unavailable", async () => {
    const { runtime } = fixture({ missingTool: "canvas_list_files_courses" });
    const report = object(await collectCanvasProgramInventory(runtime, selection));
    expect(report).toMatchObject({ coverage: { status: "inventory_incomplete", complete: false } });
    const children = report.audit_children as JsonObject[];
    expect(children).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: "morrow_audit_course", courseId: "42", sourceBindingId: "canvas-course-42" }),
    ]));
    expect(children.some((child) => object(object(child).arguments.target).kind === "file")).toBe(false);
    const course = (report.courses as JsonObject[])[0]!;
    expect(course.coverage_gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "list_unavailable", list: "files", blocking: true }),
    ]));
  });

  it("refuses a wrong fresh course result and performs no content inventory for it", async () => {
    const { runtime, calls } = fixture({ course: { id: "43", name: "Biology" } });
    const report = object(await collectCanvasProgramInventory(runtime, selection));
    expect(report).toMatchObject({ coverage: { status: "inventory_incomplete", complete: false }, audit_children: [] });
    const course = (report.courses as JsonObject[])[0]!;
    expect(course).toMatchObject({ status: "course_refused" });
    expect(course.coverage_gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "wrong_course_refused", list: "course", blocking: true }),
    ]));
    expect(calls.map((call) => call.name)).toEqual(["canvas_get_single_course_courses"]);
  });

  it("uses bounded target identities for a high-cardinality course and records durable-result coverage loss", async () => {
    const pages = Array.from({ length: 10_000 }, (_, index) => ({
      page_id: String(index + 1_000),
      url: `page-${index + 1}`,
      title: `Page ${index + 1}`,
    }));
    const { runtime } = fixture({ pages });
    const report = object(await collectCanvasProgramInventory(runtime, selection));
    const course = (report.courses as JsonObject[])[0]!;
    const targets = course.targets as JsonObject[];
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.length).toBeLessThan(pages.length);
    expect(course.coverage_gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "durable_result_target_cap_reached", list: "durable_result", blocking: true }),
    ]));
    expect(report.audit_children).toHaveLength(targets.length);
  }, 5_000);

  it("registers a bounded read-only native tool and propagates cancellation before a source call", async () => {
    const { runtime, calls } = fixture();
    const client = new Client({ name: "course-inventory-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => {
      const mcp = new McpServer({ name: "course-inventory-test", version: "1" });
      registerCourseInventoryTool(mcp, runtime);
      return mcp;
    }, { transport: b });
    await client.connect(a);
    try {
      expect((await client.listTools()).tools.find((tool) => tool.name === "morrow_inventory_courses")).toMatchObject({
        annotations: { readOnlyHint: true, destructiveHint: false },
      });
      const result = await client.callTool({ name: "morrow_inventory_courses", arguments: selection });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ schema: "morrow.course-inventory.v1", coverage: { complete: true } });
    } finally {
      await client.close();
      await server.close();
    }

    const controller = new AbortController();
    controller.abort();
    const cancelled = await collectCourseInventoryTool(runtime, selection, controller.signal);
    expect(cancelled).toMatchObject({ isError: true, structuredContent: { code: "course_inventory_unavailable" } });
    expect(calls).toHaveLength(17);
  });

  it("tracks announcement completeness separately from discussions", async () => {
    const { runtime } = fixture({ truncatedAnnouncements: true });
    const report = object(await collectCanvasProgramInventory(runtime, selection));
    expect(report).toMatchObject({ coverage: { status: "inventory_incomplete", complete: false, truncated_list_calls: 1 } });
    const course = (report.courses as JsonObject[])[0]!;
    expect(course.lists).toEqual(expect.arrayContaining([
      expect.objectContaining({ list: "discussions", status: "observed", truncated: false }),
      expect.objectContaining({ list: "announcements", status: "truncated", truncated: true }),
    ]));
    expect(course.coverage_gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "list_truncated_no_resume_token", list: "announcements", blocking: true }),
    ]));
    const targets = course.targets as JsonObject[];
    expect(targets.find((target) => target.source_list === "discussions")).toMatchObject({
      batch_eligibility: "eligible",
      inventory_state: "discovered",
    });
    expect(targets.find((target) => target.source_list === "announcements")).toMatchObject({
      batch_eligibility: "eligible",
      inventory_state: "discovered_from_incomplete_list",
    });
    const children = report.audit_children as JsonObject[];
    const topicIds = children.map((child) => object(object(child).arguments).target).map((target) => object(target).topic_id);
    expect(topicIds).toContain("13");
    expect(topicIds).toContain("23");
  });

  it("keeps the syllabus and every Page target explicit when the syllabus body and front page are not returned", async () => {
    const { runtime } = fixture({ course: { id: "42", name: "Biology" }, missingTool: "canvas_show_front_page_courses" });
    const report = object(await collectCanvasProgramInventory(runtime, selection));
    const course = (report.courses as JsonObject[])[0]!;
    expect(course).toMatchObject({ status: "inventory_complete" });
    expect(course.coverage_gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "course_syllabus_body_not_returned", list: "course", blocking: false }),
      expect.objectContaining({ code: "course_front_page_not_observed", list: "front_page", blocking: false }),
    ]));
    const targets = course.targets as JsonObject[];
    expect(targets.find((target) => object(target.target).kind === "syllabus")).toMatchObject({
      batch_eligibility: "eligible",
      discovery: { syllabus_body_returned: false },
    });
    for (const page of targets.filter((target) => object(target.target).kind === "page")) {
      expect(object(page.discovery).front_page).toBeNull();
    }
    expect(course.residual_coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "syllabus" }),
      expect.objectContaining({ category: "announcements" }),
      expect.objectContaining({ category: "rubrics" }),
      expect.objectContaining({ category: "front_page" }),
    ]));
  });

  it("associates an Item Bank with the selected course from the share row that names it", async () => {
    const { runtime, calls } = fixture({
      shares: [{ id: "80", entity_type: "course", entity_id: "42" }, { id: "81", entity_type: "Course", entity_id: "77" }],
    });
    const report = object(await collectCanvasProgramInventory(runtime, selection));
    expect(report).toMatchObject({ coverage: { status: "supported_inventory_complete", complete: true } });
    const course = (report.courses as JsonObject[])[0]!;
    const entry = itemBankEntry(course);
    expect(entry).toMatchObject({
      target: { kind: "item_bank_entry", item_bank_id: "19", entry_id: "20" },
      batch_eligibility: "eligible",
      discovery: {
        entry_type: "BankEntry",
        course_association: "observed_by_bank_share",
        course_association_evidence: {
          bank_list_course_id: "42",
          share_list_state: "observed",
          shared_course_ids: ["42", "77"],
          shared_course_count: 2,
        },
      },
    });
    expect(object(object(entry.discovery).course_association_evidence)).not.toHaveProperty("share_list_limit");
    expect(course.coverage_gaps).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "item_bank_shares_unread" })]));
    expect(calls.find((call) => call.name === "canvas_item_bank_list_shares")?.arguments).toMatchObject({ bank_id: "19", per_page: 100 });
  });

  it("names the other courses an Item Bank reaches when no share row names the selected course", async () => {
    const { runtime } = fixture({
      shares: [{ id: "80", entity_type: "course", entity_id: "77" }, { id: "81", entity_type: "course", entity_id: "9" }],
    });
    const report = object(await collectCanvasProgramInventory(runtime, selection));
    expect(report).toMatchObject({ coverage: { status: "supported_inventory_complete", complete: true } });
    const course = (report.courses as JsonObject[])[0]!;
    expect(itemBankEntry(course)).toMatchObject({
      discovery: {
        course_association: "observed_by_course_scoped_bank_list",
        course_association_evidence: {
          bank_list_course_id: "42",
          share_list_state: "observed",
          shared_course_ids: ["9", "77"],
          shared_course_count: 2,
        },
      },
    });
    expect(course.coverage_gaps).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "item_bank_shares_unread" })]));
  });

  it("keeps an Item Bank's entries auditable and blocks on the unread share list", async () => {
    const { runtime } = fixture({ missingTool: "canvas_item_bank_list_shares" });
    const report = object(await collectCanvasProgramInventory(runtime, selection));
    expect(report).toMatchObject({ coverage: { status: "inventory_incomplete", complete: false } });
    const course = (report.courses as JsonObject[])[0]!;
    expect(course.coverage_gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "list_unavailable", list: "item_bank_shares:19", blocking: true }),
      expect.objectContaining({ code: "item_bank_shares_unread", list: "item_bank_shares:19", blocking: true, sample_record_ids: ["19"] }),
    ]));
    expect(itemBankEntry(course)).toMatchObject({
      target: { kind: "item_bank_entry", item_bank_id: "19", entry_id: "20" },
      batch_eligibility: "eligible",
      discovery: {
        course_association: "not_established",
        course_association_evidence: {
          share_list_state: "unavailable",
          shared_course_ids: [],
          shared_course_count: 0,
          share_list_limit: "Morrow could not read this bank's share list.",
        },
      },
    });
    expect((report.audit_children as JsonObject[]).filter((child) => object(object(child).arguments.target).kind === "item_bank_entry")).toHaveLength(1);
  });

  it("keeps a share row it read exact while the rest of that share list stays a blocking gap", async () => {
    const { runtime } = fixture({
      truncatedTool: "canvas_item_bank_list_shares",
      shares: [{ id: "80", entity_type: "course", entity_id: "42" }],
    });
    const report = object(await collectCanvasProgramInventory(runtime, selection));
    const course = (report.courses as JsonObject[])[0]!;
    expect(course).toMatchObject({ status: "inventory_incomplete" });
    expect(course.coverage_gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "item_bank_shares_unread", list: "item_bank_shares:19", blocking: true }),
    ]));
    expect(itemBankEntry(course)).toMatchObject({
      discovery: {
        course_association: "observed_by_bank_share",
        course_association_evidence: {
          share_list_state: "incomplete",
          shared_course_ids: ["42"],
          shared_course_count: 1,
          share_list_limit: "Morrow read part of this bank's share list before a bound stopped it.",
        },
      },
    });
  });

  it("establishes no share association for an Item Bank shared with a context that is not a course", async () => {
    const { runtime } = fixture({ shares: [{ id: "80", entity_type: "account", entity_id: "3" }] });
    const report = object(await collectCanvasProgramInventory(runtime, selection));
    const course = (report.courses as JsonObject[])[0]!;
    expect(course).toMatchObject({ status: "inventory_incomplete" });
    expect(course.coverage_gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "item_bank_shares_unread", list: "item_bank_shares:19", blocking: true }),
    ]));
    expect(itemBankEntry(course)).toMatchObject({
      discovery: {
        course_association: "not_established",
        course_association_evidence: {
          share_list_state: "incomplete",
          shared_course_ids: [],
          shared_course_count: 0,
          share_list_limit: "One share names an entity of type account, not a course. No Item Bank route lists the courses inside it.",
        },
      },
    });
  });

  it("bounds the shared-course projection and never calls a full share response the whole list", async () => {
    const { runtime } = fixture({
      shares: Array.from({ length: 100 }, (_unused, index) => ({ id: String(2_000 + index), entity_type: "course", entity_id: String(100 + index) })),
    });
    const report = object(await collectCanvasProgramInventory(runtime, selection));
    const course = (report.courses as JsonObject[])[0]!;
    expect(course).toMatchObject({ status: "inventory_incomplete" });
    expect(course.coverage_gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "item_bank_shares_unread", list: "item_bank_shares:19", blocking: true }),
    ]));
    const discovery = object(itemBankEntry(course).discovery);
    expect(discovery.course_association).toBe("not_established");
    const evidence = object(discovery.course_association_evidence);
    expect(evidence).toMatchObject({ share_list_state: "incomplete", shared_course_count: 100 });
    expect(evidence.shared_course_ids).toHaveLength(50);
    expect((evidence.shared_course_ids as string[])[0]).toBe("100");
    expect(String(evidence.share_list_limit)).toContain("Item Bank share paging is not established");
  });

  it("records the course-scoped bank list as the association for an Item Bank with no shares", async () => {
    const { runtime } = fixture();
    const report = object(await collectCanvasProgramInventory(runtime, selection));
    expect(report).toMatchObject({ coverage: { status: "supported_inventory_complete", complete: true } });
    const course = (report.courses as JsonObject[])[0]!;
    expect(itemBankEntry(course)).toMatchObject({
      discovery: {
        course_association: "observed_by_course_scoped_bank_list",
        course_association_evidence: {
          bank_list_course_id: "42",
          share_list_state: "observed",
          shared_course_ids: [],
          shared_course_count: 0,
        },
      },
    });
    expect(course.coverage_gaps).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "item_bank_shares_unread" })]));
    expect(course.residual_coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "item_banks", reason: expect.stringContaining("No Item Bank route lists the quizzes that draw from a bank") }),
    ]));
  });
});

function moodleSourceResult(data: JsonObject, truncated = false): JsonObject {
  return {
    structuredContent: {
      schema: "morrow.canvas-connector.result.v1",
      ok: true,
      provider: "moodle",
      commandKind: "invoke_read",
      result: {
        schema: "morrow.moodle-browser-result.v1",
        ok: true,
        sent: true,
        data,
        truncated,
        snapshot_digest: "b".repeat(64),
      },
    },
  };
}

function moodleFixture(options: { readonly partialQuizQuestions?: boolean; readonly unreadableResourceFiles?: boolean } = {}) {
  const calls: { name: string; arguments: JsonObject }[] = [];
  const snapshots: Record<string, JsonObject> = {
    moodle_get_course: { course_id: 7, fullname: "Moodle Biology" },
    moodle_get_contents: {
      course: { id: 7, fullname: "Moodle Biology" },
      sections: [],
      activities: [
        { id: 11, module: "page", name: "Cell notes" },
        { id: 12, module: "assign", name: "Reflection" },
        { id: 13, module: "quiz", name: "Knowledge check" },
        { id: 14, module: "resource", name: "Reference PDF" },
        { id: 15, module: "forum", name: "Discussion" },
        { id: 16, module: "label", name: "Welcome text" },
        { id: 17, module: "url", name: "Publisher link" },
        { id: 18, module: "choice", name: "Check-in" },
        { id: 19, module: "book", name: "Cell handbook" },
        { id: 20, module: "lesson", name: "Cell lesson" },
        { id: 21, module: "glossary", name: "Cell terms" },
        { id: 22, module: "wiki", name: "Class wiki" },
        { id: 23, module: "feedback", name: "Course feedback" },
        { id: 24, module: "data", name: "Lab database" },
        { id: 25, module: "workshop", name: "Peer workshop" },
        { id: 26, module: "folder", name: "Lab handouts" },
        { id: 27, module: "imscp", name: "Cell IMS package" },
        { id: 28, module: "scorm", name: "Cell SCORM package" },
      ],
    },
    moodle_get_page: { course_id: 7, module_id: 11, name: "Cell notes", content: "<p>Cells</p>" },
    moodle_get_assignment: { course_id: 7, module_id: 12, name: "Reflection", instructions: "<p>Reflect</p>" },
    moodle_get_quiz: { course_id: 7, module_id: 13, name: "Knowledge check", instructions: "<p>Quiz</p>" },
    moodle_get_forum: { course_id: 7, module_id: 15, name: "Discussion", instructions: "<p>Discuss cells.</p>" },
    moodle_get_label: { course_id: 7, module_id: 16, name: "Welcome text", content: "<p>Welcome.</p>" },
    moodle_get_url: { course_id: 7, module_id: 17, name: "Publisher link", description: "<p>Use the publisher resource.</p>" },
    moodle_get_choice: { course_id: 7, module_id: 18, name: "Check-in", instructions: "<p>Choose one option.</p>" },
    moodle_get_book: { course_id: 7, module_id: 19, name: "Cell handbook", instructions: "<p>Read the handbook introduction.</p>" },
    moodle_list_book_chapters: { course_id: 7, module_id: 19, chapters: [{ chapter_id: 191, title: "Cell membrane", pagenum: 1, subchapter: false, content_file_state: "empty" }] },
    moodle_get_book_chapter: { course_id: 7, module_id: 19, chapter_id: 191, title: "Cell membrane", content: "<p>The membrane controls transport.</p>", pagenum: 1, subchapter: false, content_file_state: "empty" },
    moodle_get_lesson: { course_id: 7, module_id: 20, name: "Cell lesson", instructions: "<p>Start this lesson.</p>" },
    moodle_get_glossary: { course_id: 7, module_id: 21, name: "Cell terms", instructions: "<p>Review terms.</p>" },
    moodle_get_wiki: { course_id: 7, module_id: 22, name: "Class wiki", instructions: "<p>Contribute carefully.</p>" },
    moodle_get_feedback: { course_id: 7, module_id: 23, name: "Course feedback", instructions: "<p>Share feedback.</p>" },
    moodle_get_database: { course_id: 7, module_id: 24, name: "Lab database", instructions: "<p>Review approved records.</p>" },
    moodle_get_resource_files: {
      course_id: 7, module_id: 14, name: "Reference PDF",
      files: options.unreadableResourceFiles === true ? [{ filename: "reference.pdf" }] : [{ filename: "reference.pdf", relative_path: "reference.pdf", size_bytes: 120_345, media_type_label: "PDF document", main_file: true }],
      provenance: { source: "native_resource_settings_form", private_draft_copy_prepared: true, form_submitted: false, root_folder_only: true },
    },
    moodle_get_folder_files: {
      course_id: 7, module_id: 26, name: "Lab handouts",
      files: [
        { filename: "safety.docx", relative_path: "safety.docx", size_bytes: 22_016, media_type_label: "Word document" },
        { filename: "microscope.png", relative_path: "week-1/microscope.png", size_bytes: 88_120, media_type_label: "Image (PNG)" },
      ],
      provenance: { source: "native_folder_settings_form", private_draft_copy_prepared: true, form_submitted: false, recursive_folder_listing: true },
    },
    moodle_get_imscp: { course_id: 7, module_id: 27, name: "Cell IMS package", instructions: "<p>Open the package.</p>", keep_old_packages: "1", package_state: "not_read" },
    moodle_get_scorm: { course_id: 7, module_id: 28, name: "Cell SCORM package", instructions: "<p>Launch the module.</p>", package_type: "local", update_frequency: "0", display_mode: "0", package_state: "not_read" },
    moodle_list_quiz_questions: {
      course_id: 7,
      module_id: 13,
      truncated: options.partialQuizQuestions === true,
      questions: [
        { slot_id: 21, qtype: "essay", inspectable: true, name: "Explain cells" },
        { slot_id: 22, qtype: "truefalse", inspectable: true, name: "Unsupported current audit" },
        { slot_id: 23, qtype: "essay", inspectable: false, reason: "random_slot" },
      ],
    },
    moodle_get_quiz_question: { course_id: 7, module_id: 13, slot_id: 21, qtype: "essay", name: "Explain cells", question_text: "<p>Explain.</p>" },
    moodle_get_quiz_question_22: { course_id: 7, module_id: 13, slot_id: 22, qtype: "truefalse", name: "True or false", question_text: "<p>Cells have membranes.</p>" },
  };
  const runtime = {
    catalog: { tools: [] },
    config: { upstreams: [{ id: "moodle", outputPrivacy: {}, outputPrivacyDefault: { fieldPolicy: "scrub-sensitive", freeText: "allow", aiClientAdmission: "allow" } }] },
    searchCatalog: ({ query }: { query?: string }) => ({ tools: [{ publicName: query!, upstreamName: query!, upstreamId: "moodle", annotations: { readOnlyHint: true } }] }),
    capabilityGet: (name: string) => ({ descriptor: { provider: "moodle", route: { backend: "canvas-connector" }, sourceImplementations: [{ toolName: name }] } }),
    callSourceOwned: async (name: string, argumentsValue: JsonObject) => {
      calls.push({ name, arguments: argumentsValue });
      const slotId = name === "moodle_get_quiz_question" ? object(argumentsValue).slot_id : undefined;
      const snapshot = snapshots[name === "moodle_get_quiz_question" && slotId === 22 ? "moodle_get_quiz_question_22" : name];
      if (!snapshot) throw new Error(`unexpected Moodle inventory read ${name}`);
      return moodleSourceResult(snapshot);
    },
  } as unknown as GatewayRuntime;
  return { runtime, calls };
}

describe("Moodle selected-program inventory", () => {
  it("converts only exact Moodle form fields and chapter bodies, with explicit gaps for unread nested content", async () => {
    const { collectMoodleProgramInventory } = await import("../src/course-inventory.js");
    const { runtime, calls } = moodleFixture();
    const report = object(await collectMoodleProgramInventory(runtime, {
      provider: "moodle",
      scope: "selected_program",
      courses: [{ course_id: 7, expected_name: "Moodle Biology", source_binding_id: "moodle-course-7" }],
    }));
    expect(report).toMatchObject({
      schema: "morrow.course-inventory.v1",
      provider: "moodle",
      coverage: { status: "inventory_incomplete", complete: false },
    });
    const course = (report.courses as JsonObject[])[0]!;
    expect(course.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: { kind: "page", module_id: 11 }, batch_eligibility: "eligible" }),
      expect.objectContaining({ target: { kind: "assignment", module_id: 12 }, batch_eligibility: "eligible" }),
      expect.objectContaining({ target: { kind: "quiz", module_id: 13 }, batch_eligibility: "eligible" }),
      expect.objectContaining({ target: { kind: "quiz_question", module_id: 13, slot_id: 21 }, batch_eligibility: "eligible" }),
      expect.objectContaining({ target: { kind: "quiz_question", module_id: 13, slot_id: 22 }, batch_eligibility: "eligible" }),
      expect.objectContaining({ target: { kind: "label", module_id: 16 }, batch_eligibility: "eligible" }),
      expect.objectContaining({ target: { kind: "url", module_id: 17 }, batch_eligibility: "eligible" }),
      expect.objectContaining({ target: { kind: "book_intro", module_id: 19 }, batch_eligibility: "eligible" }),
      expect.objectContaining({ target: { kind: "book_chapter", module_id: 19, chapter_id: 191 }, batch_eligibility: "eligible" }),
      expect.objectContaining({ target: { kind: "lesson_intro", module_id: 20 }, batch_eligibility: "eligible" }),
    ]));
    expect(course.coverage_gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "activity_type_unsupported", blocking: true }),
      expect.objectContaining({ code: "activity_nested_content_not_readable", blocking: true }),
      expect.objectContaining({ code: "quiz_question_unreadable", blocking: true }),
    ]));
    expect((course.coverage_gaps as JsonObject[]).some((gap) => gap.code === "files_not_readable")).toBe(false);
    const children = report.audit_children as JsonObject[];
    expect(children).toHaveLength(18);
    expect(children.map((child) => object(child.arguments))).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "moodle", course_id: 7, source_binding_id: "moodle-course-7", target: { kind: "page", module_id: 11 } }),
      expect.objectContaining({ provider: "moodle", course_id: 7, source_binding_id: "moodle-course-7", target: { kind: "quiz_question", module_id: 13, slot_id: 21 } }),
      expect.objectContaining({ provider: "moodle", course_id: 7, source_binding_id: "moodle-course-7", target: { kind: "book_chapter", module_id: 19, chapter_id: 191 } }),
    ]));
    expect(calls.map((call) => call.name)).toEqual(expect.arrayContaining([
      "moodle_get_course", "moodle_get_contents", "moodle_get_page", "moodle_get_assignment", "moodle_get_quiz", "moodle_list_quiz_questions", "moodle_get_quiz_question",
      "moodle_get_label", "moodle_get_url", "moodle_get_forum", "moodle_get_choice", "moodle_get_book", "moodle_list_book_chapters", "moodle_get_book_chapter", "moodle_get_lesson", "moodle_get_glossary", "moodle_get_wiki", "moodle_get_feedback", "moodle_get_database",
      "moodle_get_resource_files", "moodle_get_folder_files", "moodle_get_imscp", "moodle_get_scorm",
    ]));
    expect(calls.every((call) => object(call.arguments._morrow).source_binding_id === "moodle-course-7")).toBe(true);
  });

  it("reads Resource and Folder file metadata and IMS and SCORM instructions instead of reporting them unread", async () => {
    const { collectMoodleProgramInventory } = await import("../src/course-inventory.js");
    const { runtime } = moodleFixture();
    const report = object(await collectMoodleProgramInventory(runtime, {
      provider: "moodle",
      scope: "selected_program",
      courses: [{ course_id: 7, expected_name: "Moodle Biology", source_binding_id: "moodle-course-7" }],
    }));
    const course = (report.courses as JsonObject[])[0]!;
    const targets = course.targets as JsonObject[];
    const byKind = (kind: string): JsonObject | undefined => targets.find((target) => object(target.target).kind === kind);

    const resource = object(byKind("resource_files"));
    expect(resource).toMatchObject({ target: { kind: "resource_files", module_id: 14 }, inventory_state: "discovered", batch_eligibility: "blocked" });
    expect(object(resource.discovery)).toMatchObject({
      confirmed_read_tool: "moodle_get_resource_files",
      listed_file_count: 1,
      audit_route: "not_established_for_moodle_file_metadata",
      files: [{ filename: "reference.pdf", relative_path: "reference.pdf", size_bytes: 120_345, media_type_label: "PDF document", main_file: true }],
    });

    const folder = object(byKind("folder_files"));
    expect(folder).toMatchObject({ target: { kind: "folder_files", module_id: 26 }, batch_eligibility: "blocked" });
    expect(object(folder.discovery).files).toEqual([
      { filename: "safety.docx", relative_path: "safety.docx", size_bytes: 22_016, media_type_label: "Word document", main_file: false },
      { filename: "microscope.png", relative_path: "week-1/microscope.png", size_bytes: 88_120, media_type_label: "Image (PNG)", main_file: false },
    ]);

    expect(byKind("imscp")).toMatchObject({ target: { kind: "imscp", module_id: 27 }, batch_eligibility: "eligible", discovery: { confirmed_read_tool: "moodle_get_imscp" } });
    expect(byKind("scorm")).toMatchObject({ target: { kind: "scorm", module_id: 28 }, batch_eligibility: "eligible", discovery: { confirmed_read_tool: "moodle_get_scorm" } });

    const gaps = course.coverage_gaps as JsonObject[];
    const unsupported = object(gaps.find((gap) => gap.code === "activity_type_unsupported"));
    expect(unsupported.sample_record_ids).toEqual(["25"]);
    expect(unsupported.affected_record_count).toBe(1);
    expect(gaps.filter((gap) => gap.code === "file_bytes_not_readable").map((gap) => gap.sample_record_ids).flat().sort()).toEqual(["14", "26"]);
    expect(gaps.filter((gap) => gap.code === "file_bytes_not_readable").every((gap) => String(gap.reason).includes("file metadata is not a file accessibility pass"))).toBe(true);
    const packageGap = object(gaps.find((gap) => gap.code === "package_contents_not_readable"));
    expect(packageGap.sample_record_ids).toEqual(["27", "28"]);
    expect(packageGap.reason).toContain("package contents, its navigation, learner attempts, or the learner launch");

    const residual = course.residual_coverage as JsonObject[];
    expect(residual.some((entry) => entry.category === "files" && String(entry.reason).includes("File metadata is not a file accessibility pass"))).toBe(true);
    expect(residual.some((entry) => entry.category === "packages" && String(entry.reason).includes("Package contents, package navigation, learner attempts, and the learner launch stay unread"))).toBe(true);

    const children = report.audit_children as JsonObject[];
    const childKinds = children.map((child) => object(object(child.arguments).target).kind);
    expect(childKinds).toEqual(expect.arrayContaining(["imscp", "scorm"]));
    expect(childKinds).not.toContain("resource_files");
    expect(childKinds).not.toContain("folder_files");

    // Every emitted audit child must be a target morrow_audit_course accepts.
    const { parseBatchCourseAuditInput } = await import("../src/course-audit.js");
    for (const child of children) expect(() => parseBatchCourseAuditInput(child.arguments)).not.toThrow();
  });

  it("records an explicit gap and no target when Moodle returns an inexact file listing", async () => {
    const { collectMoodleProgramInventory } = await import("../src/course-inventory.js");
    const { runtime } = moodleFixture({ unreadableResourceFiles: true });
    const report = object(await collectMoodleProgramInventory(runtime, {
      provider: "moodle",
      scope: "selected_program",
      courses: [{ course_id: 7, expected_name: "Moodle Biology", source_binding_id: "moodle-course-7" }],
    }));
    const course = (report.courses as JsonObject[])[0]!;
    expect(course.coverage_gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "file_listing_unreadable", list: "resource_files:14", blocking: true, sample_record_ids: ["14"] }),
    ]));
    const targets = course.targets as JsonObject[];
    expect(targets.some((target) => object(target.target).kind === "resource_files")).toBe(false);
    expect(targets.some((target) => object(target.target).kind === "folder_files")).toBe(true);
  });

  it("keeps Quiz targets from a partial native slot list non-batchable and records the coverage gap", async () => {
    const { collectMoodleProgramInventory } = await import("../src/course-inventory.js");
    const { runtime } = moodleFixture({ partialQuizQuestions: true });
    const report = object(await collectMoodleProgramInventory(runtime, {
      provider: "moodle",
      scope: "selected_program",
      courses: [{ course_id: 7, expected_name: "Moodle Biology", source_binding_id: "moodle-course-7" }],
    }));
    const course = (report.courses as JsonObject[])[0]!;
    expect(course.coverage_gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "native_read_partial", list: "quiz_questions:13", blocking: true }),
      expect.objectContaining({ code: "quiz_questions_partial", list: "quiz_questions:13", blocking: true }),
    ]));
    const questionTargets = (course.targets as JsonObject[]).filter((target) => object(target.target).kind === "quiz_question");
    expect(questionTargets).toHaveLength(2);
    expect(questionTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({ batch_eligibility: "blocked", inventory_state: "discovered_from_incomplete_list" }),
    ]));
    const children = report.audit_children as JsonObject[];
    expect(children.some((child) => object(object(child.arguments).target).kind === "quiz_question")).toBe(false);
  });
});
