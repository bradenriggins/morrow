import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { isJsonObject, sha256Text, type JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { collectCanvasProgramInventory } from "../src/course-inventory.js";
import {
  buildProgramAuditLedger,
  PROGRAM_LEDGER_FINAL_STATES,
  type ProgramLedgerAuditChildResult,
  type ProgramLedgerManualCheck,
} from "../src/program-ledger.js";
import { createMorrowServer } from "../src/server.js";
import type { GatewayRuntime } from "../src/runtime.js";

const selection = {
  provider: "canvas" as const,
  scope: "selected_program" as const,
  courses: [{ course_id: "42", expected_name: "Biology", source_binding_id: "canvas-course-42" }],
};

const plainText = "Lab notes: bring safety glasses.";

function object(value: unknown): JsonObject {
  expect(isJsonObject(value)).toBe(true);
  return value as JsonObject;
}

function sourceResult(data: unknown, truncated = false): JsonObject {
  return {
    structuredContent: {
      schema: "morrow.canvas-connector.result.v1",
      ok: true,
      commandKind: "invoke_read",
      result: { ok: true, sent: true, data, truncated, pageCount: 1 },
    },
  };
}

/** Collect a real inventory report so the ledger fixture cannot drift from the collector. */
function inventoryRuntime(truncatedTool?: string): GatewayRuntime {
  const snapshots: Record<string, unknown> = {
    canvas_get_single_course_courses: { id: "42", name: "Biology" },
    canvas_list_modules: [{ id: "7", name: "Orientation" }],
    canvas_list_module_items: [{ id: "71", type: "ExternalUrl", title: "Publisher simulation" }],
    canvas_list_pages_courses: [
      { page_id: "11", url: "welcome", title: "Welcome" },
      { page_id: "24", url: "syllabus", title: "Syllabus" },
    ],
    canvas_list_assignments_assignments: [{ id: "12", name: "Reflection" }, { id: "22", name: "Lab report" }],
    canvas_list_discussion_topics_courses: [
      { id: "13", title: "Introductions", is_announcement: false },
      { id: "23", title: "Week two", is_announcement: false },
    ],
    canvas_list_quizzes_in_course: [{ id: "14", title: "Classic check" }],
    canvas_list_questions_in_quiz_or_submission: [{ id: "15", question_name: "Cell question" }],
    canvas_list_new_quizzes: [{ id: "16", title: "New quiz" }],
    canvas_list_quiz_items: [{ id: "17", entry_type: "Item", entry: { title: "Cell diagram" } }],
    canvas_list_files_courses: [{ id: "18", display_name: "Course syllabus.pdf" }, { id: "21", display_name: "Lab notes.txt" }],
    canvas_list_rubrics_courses: [{ id: "25", title: "Lab report rubric" }],
    canvas_show_front_page_courses: { page_id: "11", url: "welcome", title: "Welcome", front_page: true },
    canvas_item_bank_list_banks: [{ id: "19", title: "Shared bank" }],
    canvas_item_bank_list_shares: [],
    canvas_item_bank_list_entries: [{ id: "20", entry_type: "BankEntry", entry: { title: "Shared question" } }],
  };
  return {
    catalog: { tools: [] },
    config: { upstreams: [{ id: "canvas", outputPrivacy: {}, outputPrivacyDefault: { fieldPolicy: "scrub-sensitive", freeText: "allow", aiClientAdmission: "allow" } }] },
    searchCatalog: ({ query }: { query?: string }) => ({
      tools: [{ publicName: query!, upstreamName: query!, upstreamId: "canvas", annotations: { readOnlyHint: true } }],
    }),
    capabilityGet: (name: string) => ({ descriptor: { provider: "canvas", route: { backend: "canvas-connector" }, sourceImplementations: [{ toolName: name }] } }),
    callSourceOwned: async (name: string, argumentsValue: JsonObject) => {
      expect(Object.hasOwn(snapshots, name)).toBe(true);
      // This fixture course has discussion topics and no announcements.
      if (name === "canvas_list_discussion_topics_courses" && argumentsValue.only_announcements === true) return sourceResult([]);
      return sourceResult(snapshots[name], name === truncatedTool);
    },
  } as unknown as GatewayRuntime;
}

function signalBlock(missingAlt: number): JsonObject {
  return {
    observed_source_signals: {
      image_tags_without_alt: Array.from({ length: missingAlt }, (_unused, index) => ({ image_index: index + 1, image_src_sha256: sha256Text(`image-${index}`) })),
      heading_level_jumps: [],
      tables_without_th: [],
      embedded_media_tags: [],
    },
    media_metadata: { status: "not_applicable", returned_count: 0, truncated: false },
    interpretation: "These are finite source signals only. They do not prove or disprove WCAG conformance.",
  };
}

function observedContent(field: string, content: string, missingAlt: number): JsonObject {
  return {
    status: "observed",
    disposition: "untrusted_course_content",
    field,
    content,
    sha256: sha256Text(content),
    character_count: content.length,
    ...signalBlock(missingAlt),
  };
}

function auditReport(input: {
  readonly kind: string;
  readonly id: string;
  readonly status: string;
  readonly contentEvidence: JsonObject;
  readonly remediation?: JsonObject;
  readonly extra?: JsonObject;
}): JsonObject {
  return {
    schema: "morrow.course-audit.v1",
    provider: "canvas",
    status: input.status,
    observed_at: "2026-09-06T12:00:00.000Z",
    read_started_at: "2026-09-06T11:59:59.000Z",
    source_binding_id: "canvas-course-42",
    course: { id: "42", name: "Biology" },
    target: { kind: input.kind, id: input.id, course_association: "observed_by_course_scoped_read" },
    content_evidence: input.contentEvidence,
    remediation: input.remediation ?? { status: "candidate_route_observed", readiness: "not_established_by_catalog" },
    limits: ["Observed data is limited to the exact fresh Canvas records returned here."],
    ...input.extra,
  };
}

function readyReport(kind: string, id: string, field: string, content: string, missingAlt: number, remediation?: JsonObject): JsonObject {
  return auditReport({ kind, id, status: "evidence_ready", contentEvidence: observedContent(field, content, missingAlt), ...(remediation ? { remediation } : {}) });
}

function childIdFor(report: JsonObject, target: JsonObject): string {
  const children = report.audit_children as JsonObject[];
  const match = children.find((child) => JSON.stringify(object(child.arguments).target) === JSON.stringify(target));
  expect(match, `no audit child for ${JSON.stringify(target)}`).toBeDefined();
  return String(object(match!).childId);
}

function entryFor(ledger: JsonObject, target: JsonObject): JsonObject {
  const entries = ledger.entries as JsonObject[];
  const match = entries.filter((entry) => JSON.stringify(entry.target) === JSON.stringify(target));
  expect(match, `expected exactly one ledger entry for ${JSON.stringify(target)}`).toHaveLength(1);
  return object(match[0]);
}

const oversizeContent = {
  status: "not_observed",
  disposition: "untrusted_course_content",
  field: "description",
  reason: "content_exceeds_complete_evidence_limit",
  character_count: 130_000,
  character_limit: 120_000,
  sha256: sha256Text("oversize-body"),
  detail: "This saved field is longer than 120000 characters, so this audit did not return its complete text. This is not a passed check.",
};

const blockedPdf = auditReport({
  kind: "file",
  id: "18",
  status: "blocked",
  contentEvidence: {
    status: "not_observed",
    disposition: "untrusted_course_content",
    field: "content",
    block_reason: "binary_bytes_not_readable",
    reason: "Morrow cannot read this file's bytes as text.",
  },
  remediation: { status: "manual_review_required", reason: "PDFs need manual review." },
  extra: {
    block_reason: "binary_bytes_not_readable",
    file_metadata: { status: "observed", id: "18", display_name: "Course syllabus.pdf", size: 264_192, content_type: "application/pdf" },
  },
});

const plainTextFile = auditReport({
  kind: "file",
  id: "21",
  status: "evidence_ready",
  contentEvidence: {
    status: "observed",
    disposition: "untrusted_course_content",
    field: "content",
    content: plainText,
    sha256: sha256Text(plainText),
    character_count: plainText.length,
    source_format: "plain_text",
    observed_source_signals: { status: "not_applicable", reason: "This file is plain text. HTML source checks do not apply." },
    interpretation: "The text still requires contextual review. This is not an accessibility conformance result.",
  },
  remediation: { status: "manual_review_required", reason: "File tags, captions, and learner rendering need manual review." },
});

async function fixtureLedger(): Promise<{ readonly report: JsonObject; readonly ledger: JsonObject }> {
  const report = object(await collectCanvasProgramInventory(inventoryRuntime("canvas_list_pages_courses"), selection));
  const child = (
    target: JsonObject,
    state: ProgramLedgerAuditChildResult["state"],
    extra: Partial<ProgramLedgerAuditChildResult> = {},
  ): ProgramLedgerAuditChildResult => ({
    child_id: childIdFor(report, target),
    state,
    course_id: "42",
    source_binding_id: "canvas-course-42",
    target,
    ...extra,
  });
  const children = [
    child({ kind: "assignment", assignment_id: "12" }, "succeeded", {
      report: readyReport("assignment", "12", "description", "<p><img src=\"cell.png\"></p>", 1),
    }),
    child({ kind: "assignment", assignment_id: "22" }, "succeeded", {
      report: auditReport({ kind: "assignment", id: "22", status: "evidence_incomplete", contentEvidence: oversizeContent }),
    }),
    child({ kind: "discussion", topic_id: "13" }, "succeeded", {
      report: readyReport("discussion", "13", "message", "<h2>Introduce yourself</h2>", 0),
    }),
    child({ kind: "classic_quiz", quiz_id: "14" }, "failed", {
      report: { schema: "morrow.problem.v1", code: "course_audit_privacy_policy_refused", detail_digest: sha256Text("refused") },
    }),
    child({ kind: "classic_quiz_question", quiz_id: "14", question_id: "15" }, "succeeded", {
      report: readyReport("classic_quiz_question", "15", "question_text", "<p><img src=\"q.png\"></p>", 1),
      repair: {
        operation_id: "op:classic-question-15",
        operation_state: "verified",
        verification_status: "verified",
        re_audit: readyReport("classic_quiz_question", "15", "question_text", "<p><img src=\"q.png\"></p>", 1),
      },
    }),
    child({ kind: "new_quiz", quiz_id: "16" }, "succeeded", {
      report: readyReport("new_quiz", "16", "instructions", "<p><img src=\"nq.png\"></p>", 1),
      repair: {
        operation_id: "op:new-quiz-16",
        operation_state: "verified",
        verification_status: "verified",
        re_audit: readyReport("new_quiz", "16", "instructions", "<p><img alt=\"Cell\" src=\"nq.png\"></p>", 0),
      },
    }),
    child({ kind: "new_quiz_item", quiz_id: "16", item_id: "17" }, "succeeded", {
      report: readyReport("new_quiz_item", "17", "entry.item_body", "<p><img src=\"item.png\"></p>", 1),
      repair: { operation_id: "op:new-quiz-item-17", operation_state: "applied_or_unknown", verification_status: "unconfirmed" },
    }),
    child({ kind: "item_bank_entry", item_bank_id: "19", entry_id: "20" }, "succeeded", {
      report: auditReport({
        kind: "item_bank_entry",
        id: "20",
        status: "evidence_partial_course_association",
        contentEvidence: observedContent("entry.item_body", "<p><img src=\"bank.png\"></p>", 1),
        remediation: { status: "blocked_existing_bank_writes_held", reason: "Existing Item Bank writes are held pending broader course impact proof." },
      }),
    }),
    child({ kind: "file", file_id: "18" }, "succeeded", { report: blockedPdf }),
    child({ kind: "file", file_id: "21" }, "succeeded", { report: plainTextFile }),
  ];
  const manualChecks: ProgramLedgerManualCheck[] = [{
    course_id: "42",
    source_binding_id: "canvas-course-42",
    target: { kind: "page", page_url: "welcome" },
    checked_at: "2026-09-06T09:00:00.000Z",
    note: "Reviewed the Page in the course with a keyboard and a screen reader.",
  }];
  return { report, ledger: object(buildProgramAuditLedger(report, children, manualChecks)) };
}

describe("program accessibility ledger", () => {
  it("gives every discovered target exactly one final state through each derivation rule", async () => {
    const { report, ledger } = await fixtureLedger();
    const inventoryTargets = (report.courses as JsonObject[]).flatMap((course) => course.targets as JsonObject[]);
    expect(ledger.schema).toBe("morrow.program-audit-ledger.v1");
    expect(ledger.conformance_claim).toBe("none");
    const entries = ledger.entries as JsonObject[];
    expect(entries).toHaveLength(inventoryTargets.length);
    expect(entries).toHaveLength(15);
    expect(new Set(entries.map((entry) => JSON.stringify(entry.target))).size).toBe(entries.length);
    expect(entries.every((entry) => PROGRAM_LEDGER_FINAL_STATES.includes(entry.final_state as never))).toBe(true);

    // A target Morrow read from a capped source list stays auditable. With no
    // audit result supplied for it, it is unread here, and never a pass.
    expect(entryFor(ledger, { kind: "page", page_url: "syllabus" })).toMatchObject({
      course_id: "42",
      source_list: "pages",
      final_state: "unread",
      reason: "audit_result_absent",
      detail: "No completed audit result was supplied for this discovered target.",
      evidence: { audit_status: "not_attempted" },
    });

    // A recorded manual check is the person's own statement, never a Morrow pass.
    expect(entryFor(ledger, { kind: "page", page_url: "welcome" })).toMatchObject({
      final_state: "manually_checked",
      reason: "manual_review_recorded",
      detail: expect.stringContaining("screen reader"),
    });

    // An audit child that errored is blocked with its structured failure code.
    expect(entryFor(ledger, { kind: "classic_quiz", quiz_id: "14" })).toMatchObject({
      final_state: "blocked",
      reason: "course_audit_privacy_policy_refused",
      evidence: { audit_status: "error" },
    });

    // A file Morrow could not read is blocked with its block reason, never a pass.
    const pdf = entryFor(ledger, { kind: "file", file_id: "18" });
    expect(pdf).toMatchObject({ final_state: "blocked", reason: "binary_bytes_not_readable", evidence: { audit_status: "blocked" } });
    expect(JSON.stringify(pdf)).not.toContain("evidence_ready");

    // Complete evidence with no source signal is pending review, never a pass.
    expect(entryFor(ledger, { kind: "discussion", topic_id: "13" })).toMatchObject({
      final_state: "evidence_ready_pending_review",
      reason: "no_source_signal_observed",
      evidence: { audit_status: "evidence_ready", signals: { image_tags_without_alt: 0, heading_level_jumps: 0, tables_without_th: 0, embedded_media_tags: 0 } },
    });

    // A source signal with no repair is pending review.
    expect(entryFor(ledger, { kind: "assignment", assignment_id: "12" })).toMatchObject({
      final_state: "evidence_ready_pending_review",
      reason: "source_signal_requires_review",
      evidence: { audit_status: "evidence_ready", signals: { image_tags_without_alt: 1 } },
    });

    // A verified repair whose re-audit shows the signal gone is repaired and verified.
    expect(entryFor(ledger, { kind: "new_quiz", quiz_id: "16" })).toMatchObject({
      final_state: "repaired_and_verified",
      reason: "repair_verified_and_signal_absent",
      evidence: { audit_status: "evidence_ready", operation_id: "op:new-quiz-16", verification_status: "verified", signals: { image_tags_without_alt: 0 } },
    });

    // A verified repair whose re-audit still shows the signal is not repaired.
    expect(entryFor(ledger, { kind: "classic_quiz_question", quiz_id: "14", question_id: "15" })).toMatchObject({
      final_state: "evidence_ready_pending_review",
      reason: "repair_verified_signal_still_present",
      evidence: { operation_id: "op:classic-question-15", signals: { image_tags_without_alt: 1 } },
    });

    // An applied-or-unknown repair is blocked; Morrow does not repeat that write.
    expect(entryFor(ledger, { kind: "new_quiz_item", quiz_id: "16", item_id: "17" })).toMatchObject({
      final_state: "blocked",
      reason: "unresolved_provider_effect",
      evidence: { operation_id: "op:new-quiz-item-17", verification_status: "unconfirmed" },
    });

    // A held remediation route carries the admission reason.
    expect(entryFor(ledger, { kind: "item_bank_entry", item_bank_id: "19", entry_id: "20" })).toMatchObject({
      final_state: "held",
      reason: "remediation_route_held",
      detail: "Existing Item Bank writes are held pending broader course impact proof.",
    });

    // Content the audit did not observe is unread with the content reason code.
    expect(entryFor(ledger, { kind: "assignment", assignment_id: "22" })).toMatchObject({
      final_state: "unread",
      reason: "content_exceeds_complete_evidence_limit",
      evidence: { audit_status: "evidence_incomplete", content_sha256: sha256Text("oversize-body") },
    });

    // A discovered target with no supplied audit result stays unread.
    expect(entryFor(ledger, { kind: "discussion", topic_id: "23" })).toMatchObject({
      final_state: "unread",
      reason: "audit_result_absent",
      evidence: { audit_status: "not_attempted" },
    });

    // Plain text has no HTML source signals to check, and it is recorded with its digest.
    expect(entryFor(ledger, { kind: "file", file_id: "21" })).toMatchObject({
      final_state: "not_applicable_with_evidence",
      reason: "html_source_signal_checks_not_applicable",
      evidence: { audit_status: "evidence_ready", content_sha256: sha256Text(plainText) },
    });

    const counters = object(ledger.counters);
    expect(counters.total_targets).toBe(15);
    expect(counters.final_states).toEqual({
      repaired_and_verified: 1,
      manually_checked: 1,
      not_applicable_with_evidence: 1,
      unread: 5,
      blocked: 3,
      held: 1,
      evidence_ready_pending_review: 3,
    });
    expect(counters.truncated_lists).toBe(1);
    expect(counters.unread_lists).toBe(0);
    expect(counters.manual_review_required).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "accessibility_manual_review" }),
    ]));
    expect(JSON.stringify(ledger)).not.toContain("Reflection");
  });

  it("cannot summarise a course with an unread PDF and a truncated list as all clear or passed", async () => {
    const { ledger } = await fixtureLedger();
    const counters = object(ledger.counters);
    const states = object(counters.final_states);
    expect(states.unread).toBeGreaterThan(0);
    expect(states.blocked).toBeGreaterThan(0);
    expect(counters.truncated_lists).toBeGreaterThan(0);
    expect(ledger.conformance_claim).toBe("none");
    expect(object(ledger.inventory).coverage_complete).toBe(false);
    expect(ledger.limits).toEqual(expect.arrayContaining([
      expect.stringContaining("live-unverified"),
      expect.stringContaining("do not establish WCAG conformance"),
      expect.stringContaining("are not passed targets"),
    ]));
    const serialized = JSON.stringify(ledger).toLowerCase();
    for (const claim of ["all clear", "conformant", "fully accessible", "no issues"]) {
      expect(serialized).not.toContain(claim);
    }
    const passClaims = [...serialized.matchAll(/pass(ed|es)?/g)]
      .map((match) => serialized.slice(Math.max(0, (match.index ?? 0) - 30), match.index));
    expect(passClaims.length).toBeGreaterThan(0);
    expect(passClaims.filter((prefix) => !prefix.includes("not ") && !prefix.includes("never "))).toEqual([]);
  });

  it("refuses a refused course and a child set that disagrees on target identity", async () => {
    const { report } = await fixtureLedger();
    const refused = structuredClone(report);
    (refused.courses as JsonObject[])[0]!.status = "course_refused";
    expect(() => buildProgramAuditLedger(refused)).toThrowError(/refused/i);

    const unknownChild: ProgramLedgerAuditChildResult[] = [{ child_id: "audit:not-from-this-inventory", state: "succeeded" }];
    expect(() => buildProgramAuditLedger(report, unknownChild)).toThrowError(/did not create/);

    const childId = childIdFor(report, { kind: "assignment", assignment_id: "12" });
    const wrongIdentity: ProgramLedgerAuditChildResult[] = [{
      child_id: childId,
      state: "succeeded",
      course_id: "42",
      source_binding_id: "canvas-course-42",
      target: { kind: "assignment", assignment_id: "99" },
    }];
    expect(() => buildProgramAuditLedger(report, wrongIdentity)).toThrowError(/target identity/);

    const wrongReportCourse: ProgramLedgerAuditChildResult[] = [{
      child_id: childId,
      state: "succeeded",
      report: { ...readyReport("assignment", "12", "description", "<p>Text</p>", 0), course: { id: "77", name: "Other" } },
    }];
    expect(() => buildProgramAuditLedger(report, wrongReportCourse)).toThrowError(/different course or target kind/);

    const duplicated: ProgramLedgerAuditChildResult[] = [
      { child_id: childId, state: "succeeded" },
      { child_id: childId, state: "succeeded" },
    ];
    expect(() => buildProgramAuditLedger(report, duplicated)).toThrowError(/same inventory target/);
  });

  it("registers a read-only tool with its guidance resource and resolves a saved inventory handle", async () => {
    const report = object(await collectCanvasProgramInventory(inventoryRuntime("canvas_list_pages_courses"), selection));
    const stored = JSON.stringify({ structuredContent: report });
    const runtime = {
      catalog: { tools: [] },
      config: { upstreams: [] },
      searchCatalog: () => ({ tools: [] }),
      capabilityGet: () => ({ descriptor: {} }),
      resultPage: (handle: string, offset = 0) => {
        expect(handle).toBe("result:inventory-1");
        const text = stored.slice(offset, offset + 16_000);
        const nextOffset = offset + text.length < stored.length ? offset + text.length : null;
        return { schema: "morrow.result-page.v1", handle, offset, returned: text.length, nextOffset, totalCharacters: stored.length, sha256: sha256Text(stored), text };
      },
    } as unknown as GatewayRuntime;
    const client = new Client({ name: "program-ledger", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    try {
      const tool = (await client.listTools()).tools.find((candidate) => candidate.name === "morrow_program_ledger");
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool?.description).toContain("no accessibility conformance claim");

      const guidance = await client.readResource({ uri: "morrow://guidance/program-audit-ledger-v1" });
      expect(JSON.stringify(guidance.contents)).toContain("never a pass");
      expect(JSON.stringify(guidance.contents)).toContain("do not establish WCAG conformance");

      const inline = await client.callTool({ name: "morrow_program_ledger", arguments: { inventory: report } });
      expect(inline.isError, JSON.stringify(inline.content)).not.toBe(true);
      const inlineLedger = object(inline.structuredContent);
      expect(object(inlineLedger.counters).total_targets).toBe(15);
      const summary = JSON.stringify(inline.content).toLowerCase();
      expect(summary).toContain("no accessibility conformance claim");
      expect(summary).toContain("proves no live course result");
      for (const claim of ["all clear", "passed", "no issues"]) expect(summary).not.toContain(claim);

      const handled = await client.callTool({
        name: "morrow_program_ledger",
        arguments: { inventory: { schema: "morrow.result-artifact.v1", handle: "result:inventory-1", totalCharacters: stored.length, sha256: sha256Text(stored) } },
      });
      expect(handled.isError, JSON.stringify(handled.content)).not.toBe(true);
      expect(object(handled.structuredContent).entries).toHaveLength(15);

      const refused = await client.callTool({ name: "morrow_program_ledger", arguments: { inventory: { schema: "morrow.canvas-connector.result.v1" } } });
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({ schema: "morrow.problem.v1", code: "inventory_report_unavailable" });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
