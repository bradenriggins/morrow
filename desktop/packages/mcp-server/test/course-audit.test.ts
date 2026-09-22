import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { sha256Json, sha256Text, type JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { createMorrowServer } from "../src/server.js";
import type { GatewayRuntime } from "../src/runtime.js";

const pageArgs = { provider: "canvas" as const, source_binding_id: "selected-source", course_id: "42", target: { kind: "page" as const, page_url: "cells" } };
const classicQuestionArgs = { provider: "canvas" as const, source_binding_id: "selected-source", course_id: "42", target: { kind: "classic_quiz_question" as const, quiz_id: "12", question_id: "24" } };
const classicQuizArgs = { provider: "canvas" as const, source_binding_id: "selected-source", course_id: "42", target: { kind: "classic_quiz" as const, quiz_id: "12" } };
const newQuizItemArgs = { provider: "canvas" as const, source_binding_id: "selected-source", course_id: "42", target: { kind: "new_quiz_item" as const, quiz_id: "13", item_id: "25" } };
const itemBankEntryArgs = { provider: "canvas" as const, source_binding_id: "selected-source", course_id: "42", target: { kind: "item_bank_entry" as const, item_bank_id: "14", entry_id: "26" } };
const fileArgs = { provider: "canvas" as const, source_binding_id: "selected-source", course_id: "42", target: { kind: "file" as const, file_id: "27" } };
const syllabusArgs = { provider: "canvas" as const, source_binding_id: "selected-source", course_id: "42", target: { kind: "syllabus" as const } };
const rubricArgs = { provider: "canvas" as const, source_binding_id: "selected-source", course_id: "42", target: { kind: "rubric" as const, rubric_id: "28" } };
const syllabusBody = "<h1>Course syllabus</h1><h3>Late work</h3><img src=\"policy.png\">";
const classicQuizDescription = "<p>Read the diagram before you start.</p><img src=\"quiz-diagram.png\">";
/** Lives on the item bank question, never on the entry row that names it. */
const bankItemBody = "<p>Choose the membrane.</p><img src=\"bank-item.png\">";
/** One positive case for every saved-source signal, ending with a table the source never closes. */
const signalPositiveBody = [
  "<h1>Cells</h1>",
  "<h2></h2>",
  "<p><a href=\"https://example.edu/lab\">https://example.edu/lab</a></p>",
  "<p><a href=\"/syllabus\">Click here</a></p>",
  "<p><a href=\"/lab\"><img src=\"icon.png\" alt=\"\"></a></p>",
  "<img src=\"divider.png\" role=\"presentation\" alt=\"Section divider\">",
  "<iframe src=\"player.html\"></iframe>",
  "<video src=\"lecture.mp4\" autoplay></video>",
  "<button aria-hidden=\"true\">Start</button>",
  "<div style=\"width: 720px\">Fixed width</div>",
  "<font color=\"red\">Old markup</font>",
  "<table><tr><th scope=\"col\">Week</th></tr><tr><td>1</td></tr></table>",
  "<table><tr><th>Topic</th></tr><tr><td>Cells</td></tr>",
].join("");
/** The same markup written so that every one of those signals stays silent. */
const signalNegativeBody = [
  "<h1>Cells</h1>",
  "<h2>Structure</h2>",
  "<p><a href=\"https://example.edu/lab\">Read the lab safety guide</a></p>",
  "<p><a href=\"/home\" aria-label=\"Course home\"><img src=\"home.png\" alt=\"\"></a></p>",
  "<img src=\"rule.png\" role=\"presentation\" alt=\"\">",
  "<iframe src=\"player.html\" title=\"Lecture player\"></iframe>",
  "<video src=\"lecture.mp4\"><track kind=\"captions\" src=\"lecture.vtt\"></video>",
  "<button>Start</button>",
  "<span aria-hidden=\"true\">*</span>",
  "<div tabindex=\"-1\" aria-hidden=\"true\">Skipped</div>",
  "<span style=\"width: 720px\">Inline</span>",
  "<div style=\"max-width: 720px\">Fluid</div>",
  "<table><caption>Weeks</caption><tr><th scope=\"col\">Week</th></tr><tr><td>1</td></tr></table>",
].join("");
const fileText = '\uFEFFCell notes: the literal example <img src="example.png"> is plain text.';
const fileSignals = {
  format: "pdf", pdf_version: "1.7", page_count: 12, encryption: "absent", marked_content_flag: "absent",
  structure_tree_root: "absent", document_language: "not_determinable", document_language_value_length: null,
  text_showing_operators: "present", pages_with_text_showing_operators: 12, object_streams_inflated: 2,
  interpretation: "Structural signals only. They do not establish document accessibility, tagging quality, reading order, or WCAG conformance.",
};
const moodleQuestionArgs = { provider: "moodle" as const, source_binding_id: "selected-source", course_id: 7, target: { kind: "quiz_question" as const, module_id: 8, slot_id: 9 } };
const moodleTrueFalseArgs = { provider: "moodle" as const, source_binding_id: "selected-source", course_id: 7, target: { kind: "quiz_question" as const, module_id: 14, slot_id: 15 } };
const moodleBookIntroArgs = { provider: "moodle" as const, source_binding_id: "selected-source", course_id: 7, target: { kind: "book_intro" as const, module_id: 10 } };
const moodleBookChapterArgs = { provider: "moodle" as const, source_binding_id: "selected-source", course_id: 7, target: { kind: "book_chapter" as const, module_id: 10, chapter_id: 11 } };
const moodleLabelArgs = { provider: "moodle" as const, source_binding_id: "selected-source", course_id: 7, target: { kind: "label" as const, module_id: 12 } };
const page = {
  page_id: "91", url: "cells", title: "Cells", body: "<!-- <img src=\"comment.png\"> --><h1>Cells</h1><script>const x = '<h6>not a heading</h6><img src=\"script.png\">';</script><h3>Structure</h3><img data-alt=\"diagram\" src=\"diagram.png\"><table><tr><td>Cell</td></tr></table><video src=\"cells.mp4\"></video>",
};

function catalogDescriptor(provider: "canvas" | "moodle", name: string, inputSchema?: JsonObject) {
  return {
    provider,
    route: { backend: "canvas-connector" },
    ...(inputSchema ? { inputSchema } : {}),
    sourceImplementations: [{
      system: "morrow-fixture", toolName: name, sourceExport: `operation:${name}`,
      sourcePath: "fixtures/course-audit-catalog.json", sourceDigest: "a".repeat(64),
    }],
  };
}

function fixture() {
  const calls: { name: string; arguments: JsonObject }[] = [];
  /** The fixture's guarded write routes. Everything else answers as a read. */
  const writeTools = new Set(["canvas_update_create_page_courses", "canvas_update_course", "canvas_edit_quiz", "canvas_update_existing_quiz_question", "canvas_item_bank_update_item"]);
  const writeSchemas: Record<string, JsonObject> = {
    canvas_update_course: { type: "object", properties: { id: {}, course_name: {}, course_syllabus_body: {} } },
  };
  const snapshots: Record<string, JsonObject> = {
    canvas_get_single_course_courses: { id: "42", name: "Biology", syllabus_body: syllabusBody },
    canvas_get_single_rubric_courses: {
      id: "28", title: "Lab report rubric", points_possible: 10,
      data: [{
        id: "_1", points: 10, description: "<p>Evidence <img src=\"criterion.png\"></p>", long_description: "<h1>Evidence</h1><h3>Detail</h3>",
        ratings: [{ id: "r1", points: 10, description: "<table><tr><td>Full marks</td></tr></table>" }, { id: "r2", points: 0, description: "Not yet" }],
      }],
    },
    canvas_show_page_courses: page,
    canvas_get_single_quiz: { id: "12", title: "Cell structure check", description: classicQuizDescription, published: true },
    canvas_get_single_quiz_question: {
      id: "24", question_name: "Cell structure", question_text: "<p>Which part controls the cell?</p>", question_type: "multiple_choice_question", points_possible: 2,
      answers: [{ id: "a", answer_text: "<p><img src=\"answer.png\"></p>", answer_weight: 100, answer_comments: "Correct" }, { id: "b", answer_text: "Cell wall", answer_weight: 0, answer_comments: "Review the diagram" }],
      correct_comments: "Correct", incorrect_comments: "Review the diagram", neutral_comments: "", correct_comments_html: "<p>Correct</p>", incorrect_comments_html: "<p>Review the diagram</p>", neutral_comments_html: "",
    },
    canvas_get_quiz_item: {
      id: "25", points_possible: 3, entry_type: "Item", stimulus_quiz_entry_id: null,
      entry: {
        title: "Plant cells", item_body: "<p>Choose the organelle.</p>", interaction_type_slug: "choice",
        interaction_data: { choices: [{ id: "a", itemBody: "<p><img src=\"choice.png\"></p>" }, { id: "b", itemBody: "Nucleus" }] },
        scoring_data: { value: 3, scoring_algorithm: "all_or_nothing" }, feedback: { neutral: "<video src=\"feedback.mp4\"></video>" }, answer_feedback: { a: "<table><tr><td>Review</td></tr></table>" }, feedback_data: { format: "html" },
      },
    },
    canvas_get_quiz_item_related_stimulus: {
      id: "31", points_possible: 0, entry_type: "Stimulus", stimulus_quiz_entry_id: null,
      entry: {
        title: "Cell membrane diagram", body: "<p><img src=\"stimulus-linked.png\"></p>", instructions: "Use the diagram.",
        source_url: "https://example.edu/cell-membrane", orientation: "left", passage: false,
      },
    },
    // A bank entry row names its question and carries only a partial copy of it,
    // exactly as section 3.3 of the harvested Item Banks contract describes.
    canvas_item_bank_get_entry: { id: "26", entry_type: "Item", entry_id: "44", entry: { title: "Bank cells" } },
    canvas_item_bank_get_item: {
      id: "44", entry_type: "Item", stimulus_quiz_entry_id: null,
      entry: {
        title: "Bank cells", item_body: bankItemBody, interaction_type_slug: "choice",
        interaction_data: { choices: { a: { id: "a", item_body: "<p><img src=\"bank-choice.png\"></p>" }, b: { id: "b", item_body: "Nucleus" } } },
        scoring_data: { value: 3, scoring_algorithm: "all_or_nothing" }, feedback: { neutral: "<audio src=\"bank-feedback.mp3\"></audio>" }, answer_feedback: {},
      },
    },
    canvas_get_file_courses: {
      id: "27", display_name: "Cell notes.txt", filename: "cell-notes.txt", "content-type": "text/plain", size: Buffer.byteLength(fileText),
      updated_at: "2026-09-06T00:00:00Z", modified_at: null,
    },
    canvas_read_course_file_text: {
      id: "27", display_name: "Cell notes.txt", filename: "cell-notes.txt", content_type: "text/plain", size: Buffer.byteLength(fileText),
      updated_at: "2026-09-06T00:00:00Z", modified_at: null, content: fileText, content_byte_length: Buffer.byteLength(fileText),
      content_sha256: sha256Text(fileText),
    },
    // The structural signal route returns counts and presence states only. The
    // shape here is the one scripts/test/canvas-file-signals.test.mjs proves
    // against hand-built PDF and Office fixtures.
    canvas_read_course_file_signals: {
      id: "27", display_name: "Course syllabus.pdf", filename: "course-syllabus.pdf", content_type: "application/pdf", size: 264_192,
      updated_at: "2026-09-06T00:00:00Z", modified_at: null, content_byte_length: 264_192, content_sha256: "c".repeat(64),
      file_signals: fileSignals,
    },
  };
  const refusals: Record<string, string> = {};
  const runtime = {
    catalog: { tools: [] },
    config: { upstreams: [{ id: "canvas", outputPrivacy: {}, outputPrivacyDefault: { fieldPolicy: "scrub-sensitive", freeText: "allow", aiClientAdmission: "allow" } }] },
    searchCatalog: ({ query }: { query: string }) => ({
      tools: [{ publicName: query, upstreamName: query, upstreamId: "canvas", annotations: { readOnlyHint: !writeTools.has(query) } }],
    }),
    capabilityGet: (name: string) => ({ descriptor: catalogDescriptor("canvas", name, writeSchemas[name]) }),
    callSourceOwned: async (name: string, arguments_: JsonObject) => {
      expect(Object.hasOwn(snapshots, name) || Object.hasOwn(refusals, name)).toBe(true);
      calls.push({ name, arguments: arguments_ });
      if (Object.hasOwn(refusals, name)) {
        return {
          isError: true,
          content: [{ type: "text", text: "Morrow read Canvas data." }],
          structuredContent: {
            schema: "morrow.canvas-connector.result.v1", ok: false, provider: "canvas", resultState: "not_sent",
            problem: { schema: "morrow.bridge.problem.v1", code: "canvas_request_not_sent", message: refusals[name], recoverable: true },
          },
        };
      }
      // Canvas returns syllabus_body only for a read that asks for it.
      const record = name === "canvas_get_quiz_item" && String(arguments_.item_id) === "31"
        ? snapshots.canvas_get_quiz_item_related_stimulus
        : snapshots[name] as JsonObject;
      const { syllabus_body: syllabusBody, ...courseWithoutSyllabus } = record;
      const data = name === "canvas_get_single_course_courses" && !(Array.isArray(arguments_.include) && arguments_.include.includes("syllabus_body"))
        ? courseWithoutSyllabus
        : record;
      return {
        structuredContent: {
          schema: "morrow.canvas-connector.result.v1", ok: true, commandKind: "invoke_read",
          result: {
            ok: true, sent: true, truncated: false, data,
            ...(name === "canvas_show_page_courses"
              ? {
                pageBodySha256: sha256Text(String(record.body)),
                // Morrow Bridge attaches this record after the sandboxed render
                // check. Every other read here returns none, which the audit
                // must report as not observed rather than as a passed check.
                renderCheck: {
                  schema: "morrow.canvas-render-check.v1", status: "observed",
                  evidence_class: "saved_source_render_signal_live_unverified",
                  field: "body", source_character_count: String(record.body).length,
                  element_count: 6, truncated: false,
                  not_determinable_without_course_theme: [{ check: "colour_contrast", reason: "The course theme sets it." }],
                },
              }
              : {}),
          },
        },
      };
    },
  } as unknown as GatewayRuntime;
  return { runtime, calls, snapshots, refusals, writeSchemas, writeTools };
}

/**
 * The exact result envelope each Moodle read executor returns. The activity
 * settings-form readers dispatch the native request and report `sent: true`;
 * the child-record readers send no state-changing request and report
 * `complete: true`. Two of them name no native target at all.
 * Sources: connector/extension/src/moodle-workshop-executor.js,
 * moodle-h5p-executor.js, moodle-glossary-wiki-executor.js,
 * moodle-lesson-read.js, and moodle-activity-content-read.js.
 */
const moodleReadEnvelopes: Record<string, JsonObject> = {
  moodle_get_workshop: { ok: true, sent: true, status: 200 },
  moodle_get_h5pactivity: { ok: true, sent: true, status: 200, targets: [] },
  moodle_get_glossary_entry: { ok: true, sent: false, complete: true, status: 200, targets: [] },
  moodle_get_wiki_page: { ok: true, sent: false, complete: true, status: 200, targets: [] },
  moodle_get_lesson_page: { ok: true, sent: false, complete: true },
  moodle_get_feedback_items: { ok: true, sent: false, complete: true },
  moodle_get_database_fields: { ok: true, sent: false, complete: true },
};

function moodleFixture(options: { readonly envelopes?: Record<string, JsonObject>; readonly snapshots?: Record<string, JsonObject> } = {}) {
  const snapshots: Record<string, JsonObject> = {
    moodle_get_course: { course_id: 7, fullname: "Biology" },
    moodle_get_workshop: { course_id: 7, module_id: 30, name: "Peer review", instructions: "<p>Read the brief.</p><img src=\"brief.png\">", submission_instructions: "<p>Upload one draft.</p>", assessment_instructions: "<p>Use the rubric.</p>", conclusion: "<p>Thank you.</p>" },
    moodle_get_h5pactivity: { course_id: 7, module_id: 31, name: "Cell explorer", instructions: "<p>Open the interactive.</p>" },
    moodle_get_glossary_entry: { course_id: 7, module_id: 32, entry_id: 320, concept: "Mitochondrion", definition: "<p>The organelle that releases energy.</p>", definition_format: "1", approved: true, has_attachment: false },
    moodle_get_wiki_page: { course_id: 7, module_id: 33, page_id: 330, title: "Lab safety", version: 4, content_format: "html", content: "<h1>Lab safety</h1><h3>Goggles</h3>" },
    moodle_get_lesson_page: { course_id: 7, module_id: 34, page_id: 340, title: "Osmosis", page_type: "multichoice", contents_text: "<p>Water moves across the membrane.</p>", answer_count: 2 },
    moodle_get_feedback_items: {
      course_id: 7, module_id: 35, feedback_id: 350, anonymous: true, item_count: 2,
      items: [
        { item_id: 351, position: 1, type: "textfield", required: true, text: "<p>Name one thing that worked.</p>", label: "worked", presentation: "30|255", depends_on_item_id: null, depends_on_value: "" },
        { item_id: 352, position: 2, type: "multichoice", required: false, text: "<p>Rate the lab.</p>", label: "rating", presentation: "r>>>>>1|2|3", depends_on_item_id: null, depends_on_value: "" },
      ],
    },
    moodle_get_database_fields: {
      course_id: 7, module_id: 36, database_id: 360, field_count: 2, default_sort_field_id: 361,
      fields: [{ field_id: 361, name: "Specimen name", type: "text" }, { field_id: 362, name: "Habitat photo", type: "picture" }],
    },
    moodle_get_quiz_question: {
      course_id: 7, module_id: 8, slot_id: 9, qtype: "multichoice", name: "Cell structure", question_text: "<p>Choose an organelle.</p>", default_mark: "2.0", general_feedback: "Review the diagram.",
      details: { choices: [{ text: "Nucleus", format: "html", fraction: "1.0", feedback: "Correct", feedback_format: "html" }], choices_truncated: true },
    },
    moodle_get_quiz_question_truefalse: {
      course_id: 7, module_id: 14, slot_id: 15, qtype: "truefalse", name: "Cells have membranes", question_text: "<p>Cells have membranes.</p>", default_mark: "1.0", general_feedback: "Review cell structure.", details: {},
    },
    moodle_get_book: { course_id: 7, module_id: 10, name: "Cell handbook", instructions: "<p>Read the handbook introduction.</p>" },
    moodle_get_book_chapter: { course_id: 7, module_id: 10, chapter_id: 11, title: "Cell membrane", content: "<p>The membrane controls transport.</p>" },
    moodle_get_label: { course_id: 7, module_id: 12, name: "Welcome text", content: "<p>Welcome to biology.</p>" },
    ...options.snapshots,
  };
  const envelopes = { ...moodleReadEnvelopes, ...options.envelopes };
  return {
    catalog: { tools: [] },
    config: { upstreams: [{ id: "moodle", outputPrivacy: {}, outputPrivacyDefault: { fieldPolicy: "scrub-sensitive", freeText: "allow", aiClientAdmission: "allow" } }] },
    searchCatalog: ({ query }: { query: string }) => ({ tools: [{ publicName: query, upstreamName: query, upstreamId: "moodle", annotations: { readOnlyHint: true } }] }),
    capabilityGet: (name: string) => ({ descriptor: catalogDescriptor("moodle", name) }),
    callSourceOwned: async (name: string, argumentsValue: JsonObject) => ({
      structuredContent: {
        schema: "morrow.canvas-connector.result.v1", ok: true, provider: "moodle", commandKind: "invoke_read",
        result: {
          ...(envelopes[name] ?? { ok: true, sent: true, truncated: false, targets: [] }),
          data: snapshots[name === "moodle_get_quiz_question" && argumentsValue.slot_id === 15 ? "moodle_get_quiz_question_truefalse" : name],
          snapshot_digest: "b".repeat(64),
        },
      },
    }),
  } as unknown as GatewayRuntime;
}

describe("course audit", () => {
  it("reads exact Canvas content and question evidence with active-catalog provenance", async () => {
    const { runtime, calls, snapshots } = fixture();
    const client = new Client({ name: "course-audit-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    try {
      expect((await client.listTools()).tools.find((tool) => tool.name === "morrow_audit_course")?.annotations?.readOnlyHint).toBe(true);
      expect((await client.listResources()).resources).toEqual(expect.arrayContaining([expect.objectContaining({ uri: "morrow://guidance/course-audit-v1" })]));
      const guidance = await client.readResource({ uri: "morrow://guidance/course-audit-v1" });
      expect(JSON.stringify(guidance.contents)).toContain("WCAG 2.2");
      expect(JSON.stringify(guidance.contents)).toContain("untrusted data");
      expect(JSON.stringify(guidance.contents)).toContain("does not prove a course conforms");
      expect(JSON.stringify(guidance.contents)).toContain("two or three representative sources");
      expect(JSON.stringify(guidance.contents)).toContain("saved-source evidence, rendered learner-view evidence, and manual accessibility checks");
      expect(JSON.stringify(guidance.contents)).toContain("File metadata alone is not file bytes");
      expect(JSON.stringify(guidance.contents)).toContain("not a tool error");
      expect(JSON.stringify(guidance.contents)).toContain("content_exceeds_complete_evidence_limit");
      expect(JSON.stringify(guidance.contents)).toContain("New Quiz item needs its selected course, quiz, and item");

      const pageResult = await client.callTool({ name: "morrow_audit_course", arguments: pageArgs });
      expect(pageResult.isError, JSON.stringify(pageResult.content)).not.toBe(true);
      const pageReport = pageResult.structuredContent as JsonObject;
      expect(pageReport.course).toEqual({ id: "42", name: "Biology" });
      expect(pageReport.target).toMatchObject({ kind: "page", id: "91", title: "Cells" });
      expect(pageReport.content_evidence).toMatchObject({ status: "observed", disposition: "untrusted_course_content", field: "body", sha256: sha256Text(page.body) });
      expect(((pageReport.content_evidence as JsonObject).observed_source_signals as JsonObject)).toMatchObject({
        image_tags_without_alt: [{ image_index: 1, image_src_sha256: sha256Text("diagram.png") }], heading_level_jumps: [{ heading_index: 2, from_level: 1, to_level: 3 }], tables_without_th: [1], embedded_media_tags: [1],
      });
      expect(pageReport.upstream_read_provenance).toEqual(expect.arrayContaining([expect.objectContaining({
        status: "observed_from_active_catalog", upstream_read_tool: "canvas_show_page_courses", operation_key: "operation:canvas_show_page_courses", documentation_source: "fixtures/course-audit-catalog.json",
      })]));
      expect(pageReport.remediation).toMatchObject({ status: "candidate_route_observed", upstream_tool: "canvas_update_create_page_courses", field: "wiki_page_body", readiness: "not_established_by_catalog" });
      // The render record is attached only when it names the exact field this
      // audit reports, at the exact length it reports.
      expect(pageReport.render_evidence).toMatchObject({
        schema: "morrow.canvas-render-check.v1", status: "observed", field: "body",
        evidence_class: "saved_source_render_signal_live_unverified", source_character_count: page.body.length,
      });
      expect(JSON.stringify(pageReport.limits)).toContain("not from the learner's Canvas page");

      const classicResult = await client.callTool({ name: "morrow_audit_course", arguments: classicQuestionArgs });
      const classicReport = classicResult.structuredContent as JsonObject;
      // No Bridge render record for this read, so the audit says so instead of
      // leaving the rendered checks looking done.
      expect(classicReport.render_evidence).toMatchObject({
        status: "not_observed", field: "question_text", reason: "render_check_not_returned",
        evidence_class: "saved_source_render_signal_live_unverified",
      });
      expect(classicReport.status).toBe("evidence_incomplete");
      expect(classicReport.assessment_evidence).toMatchObject({ status: "evidence_incomplete", disposition: "untrusted_course_content" });
      expect((classicReport.assessment_evidence as JsonObject).answers).toMatchObject({ status: "observed" });
      expect((classicReport.assessment_evidence as JsonObject).scoring).toMatchObject({ status: "observed", source_fields: ["points_possible", "answers"] });
      expect((classicReport.assessment_evidence as JsonObject).feedback).toMatchObject({ status: "observed" });
      expect((classicReport.assessment_evidence as JsonObject).html_fields).toMatchObject({
        status: "observed", fields: expect.arrayContaining([expect.objectContaining({ field: "answers[0].answer_text", sha256: sha256Text("<p><img src=\"answer.png\"></p>"), value: "<p><img src=\"answer.png\"></p>", observed_source_signals: expect.objectContaining({ image_tags_without_alt: expect.any(Array) }) })]),
        media_review: expect.objectContaining({ status: "manual_review_required" }),
      });
      expect(classicReport.remediation).toMatchObject({
        status: "candidate_route_observed",
        upstream_tool: "canvas_update_existing_quiz_question",
        field: "question_question_text",
        readiness: "not_established_by_catalog",
        image_alt_repair: {
          status: "candidate_route_observed",
          planner: "morrow_plan_classic_quiz_question_image_alt_repair",
          readiness: "not_established_by_catalog",
          live_verification: "not_established_by_live_tenant",
        },
      });

      const newQuizResult = await client.callTool({ name: "morrow_audit_course", arguments: newQuizItemArgs });
      const newQuizReport = newQuizResult.structuredContent as JsonObject;
      expect(newQuizReport.status).toBe("evidence_incomplete");
      expect(newQuizReport.assessment_evidence).toMatchObject({ status: "evidence_incomplete", disposition: "untrusted_course_content" });
      expect((newQuizReport.assessment_evidence as JsonObject).scoring).toMatchObject({ status: "observed" });
      expect((newQuizReport.assessment_evidence as JsonObject).feedback).toMatchObject({ value: { feedback_data: { format: "html" } } });
      expect((newQuizReport.assessment_evidence as JsonObject).html_fields).toMatchObject({
        status: "observed", fields: expect.arrayContaining([
          expect.objectContaining({ field: "entry.interaction_data.choices[0].itemBody", sha256: sha256Text("<p><img src=\"choice.png\"></p>"), value: "<p><img src=\"choice.png\"></p>", observed_source_signals: expect.objectContaining({ image_tags_without_alt: expect.any(Array) }) }),
          expect.objectContaining({ field: "entry.feedback.neutral", sha256: sha256Text("<video src=\"feedback.mp4\"></video>"), observed_source_signals: expect.objectContaining({ embedded_media_tags: [1] }) }),
          expect.objectContaining({ field: "entry.answer_feedback[a]", observed_source_signals: expect.objectContaining({ tables_without_th: [1] }) }),
        ]),
        media_review: expect.objectContaining({ status: "manual_review_required" }),
      });
      expect((newQuizReport.assessment_evidence as JsonObject).choice_answer_evidence).toMatchObject({
        status: "evidence_incomplete",
        selector_state: { status: "observed", returned_field_count: 2 },
        source: { status: "observed", field: "entry.interaction_data.choices", value: expect.any(Array) },
      });
      expect((newQuizReport.assessment_evidence as JsonObject).stimulus).toMatchObject({ status: "not_applicable" });
      expect(newQuizReport.remediation).toMatchObject({
        status: "blocked_current_catalog",
        upstream_tool: "canvas_update_quiz_item",
        image_alt_repair: { status: "blocked_current_catalog" },
      });

      (snapshots.canvas_get_quiz_item as JsonObject).stimulus_quiz_entry_id = "31";
      const linkedStimulusResult = await client.callTool({ name: "morrow_audit_course", arguments: newQuizItemArgs });
      const linkedStimulusReport = linkedStimulusResult.structuredContent as JsonObject;
      expect(linkedStimulusReport.status).toBe("evidence_incomplete");
      expect((linkedStimulusReport.assessment_evidence as JsonObject).stimulus).toMatchObject({
        relation: "linked_stimulus_entry",
        stimulus_quiz_entry_id: "31",
        source_field: "entry.body",
        body: { status: "observed", field: "entry.body", value: "<p><img src=\"stimulus-linked.png\"></p>" },
        html_fields: {
          fields: expect.arrayContaining([
            expect.objectContaining({ field: "entry.body", observed_source_signals: expect.objectContaining({ image_tags_without_alt: expect.any(Array) }) }),
          ]),
        },
      });
      expect(calls.filter((call) => call.name === "canvas_get_quiz_item" && call.arguments.item_id === "31")).toHaveLength(1);

      (snapshots.canvas_get_quiz_item as JsonObject).entry_type = "Stimulus";
      (snapshots.canvas_get_quiz_item as JsonObject).stimulus_quiz_entry_id = null;
      (snapshots.canvas_get_quiz_item as JsonObject).entry = {
        title: "Cell diagram", body: "<p><img src=\"stimulus.png\"></p>", instructions: "Use the labeled image.", source_url: "https://example.edu/cell-diagram",
        orientation: "left", passage: false, created_at: "2026-09-05T00:00:00Z", updated_at: "2026-09-05T00:01:00Z",
      };
      const directStimulusResult = await client.callTool({ name: "morrow_audit_course", arguments: newQuizItemArgs });
      const directStimulusReport = directStimulusResult.structuredContent as JsonObject;
      expect(directStimulusReport.status).toBe("evidence_incomplete");
      expect(directStimulusReport.content_evidence).toMatchObject({ field: "entry.body", observed_source_signals: expect.objectContaining({ image_tags_without_alt: expect.any(Array) }) });
      expect((directStimulusReport.assessment_evidence as JsonObject).stimulus).toMatchObject({ status: "observed", source_field: "entry.body" });
      expect((directStimulusReport.assessment_evidence as JsonObject).stimulus).toMatchObject({
        metadata: { fields: expect.arrayContaining([expect.objectContaining({ field: "entry.source_url", sha256: sha256Text(JSON.stringify("https://example.edu/cell-diagram")), value: "https://example.edu/cell-diagram" })]) },
      });
      expect(directStimulusReport.remediation).toMatchObject({
        status: "blocked_current_contract",
        upstream_tool: "canvas_update_quiz_item",
        reason: expect.stringMatching(/only entry_type "Item" on create and update/),
      });

      const itemBankResult = await client.callTool({ name: "morrow_audit_course", arguments: itemBankEntryArgs });
      const itemBankReport = itemBankResult.structuredContent as JsonObject;
      expect(itemBankReport.status).toBe("evidence_incomplete");
      // The entry row carries no question body. The audit reports the question the row names.
      expect(itemBankReport.target).toMatchObject({
        kind: "item_bank_entry", id: "26", item_id: "44", title: "Bank cells",
        course_association: "observed_by_course_scoped_read",
        association: expect.stringMatching(/selected course's scoped bank list/),
      });
      expect(itemBankReport.content_evidence).toMatchObject({ status: "observed", field: "entry.item_body", content: bankItemBody, sha256: sha256Text(bankItemBody) });
      expect(itemBankReport.assessment_evidence).toMatchObject({ status: "evidence_incomplete", disposition: "untrusted_course_content", points_possible: { status: "not_observed" } });
      expect((itemBankReport.assessment_evidence as JsonObject).html_fields).toMatchObject({
        status: "observed", fields: expect.arrayContaining([
          expect.objectContaining({ field: "entry.interaction_data.choices[a].item_body", observed_source_signals: expect.objectContaining({ image_tags_without_alt: expect.any(Array) }) }),
          expect.objectContaining({ field: "entry.feedback.neutral", observed_source_signals: expect.objectContaining({ embedded_media_tags: [1] }) }),
        ]),
      });
      const fileResult = await client.callTool({ name: "morrow_audit_course", arguments: fileArgs });
      const fileReport = fileResult.structuredContent as JsonObject;
      expect(fileReport.status).toBe("evidence_ready");
      expect(fileReport.target).toMatchObject({ kind: "file", id: "27", title: "Cell notes.txt", course_association: "observed_by_course_scoped_read" });
      expect(fileReport.content_evidence).toMatchObject({ status: "observed", field: "content", content: fileText, sha256: sha256Text(fileText), source_format: "plain_text", observed_source_signals: { status: "not_applicable" } });
      expect((fileReport.content_evidence as JsonObject).observed_source_signals).not.toHaveProperty("image_tags_without_alt");
      expect(fileReport.file_metadata).toEqual({ status: "observed", id: "27", display_name: "Cell notes.txt", size: Buffer.byteLength(fileText), content_type: "text/plain" });
      expect((fileReport.remediation as JsonObject)).toMatchObject({ status: "manual_review_required" });
      expect(calls.map((call) => call.name)).toEqual([
        "canvas_get_single_course_courses", "canvas_show_page_courses", "canvas_get_single_course_courses", "canvas_get_single_quiz_question", "canvas_get_single_course_courses", "canvas_get_quiz_item", "canvas_get_single_course_courses", "canvas_get_quiz_item", "canvas_get_quiz_item", "canvas_get_single_course_courses", "canvas_get_quiz_item", "canvas_get_single_course_courses", "canvas_item_bank_get_entry", "canvas_item_bank_get_item", "canvas_get_single_course_courses", "canvas_get_file_courses", "canvas_read_course_file_text",
      ]);
      expect(calls.every((call) => (call.arguments._morrow as JsonObject).source_binding_id === pageArgs.source_binding_id)).toBe(true);
    } finally { await client.close(); await server.close(); }
  });

  it("reads an item bank question and offers only the snapshot-bound repair candidate", async () => {
    const { runtime, calls, snapshots, writeTools } = fixture();
    const questionDigest = sha256Json(snapshots.canvas_item_bank_get_item);
    const client = new Client({ name: "course-audit-item-bank", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    try {
      const guidance = JSON.stringify((await client.readResource({ uri: "morrow://guidance/course-audit-v1" })).contents);
      expect(guidance).toContain("morrow_read_item_bank_fan_out");
      expect(guidance).toContain("a list row is not a question");
      expect(guidance).toContain("morrow_plan_item_bank_question_image_alt_repair");
      expect(guidance).toContain("never treat an incomplete result as an authority grant");

      const question = await client.callTool({ name: "morrow_audit_course", arguments: itemBankEntryArgs });
      const questionReport = question.structuredContent as JsonObject;
      expect(questionReport.target).toMatchObject({
        kind: "item_bank_entry", id: "26", item_id: "44", item_sha256: questionDigest, course_association: "observed_by_course_scoped_read",
        item_bank_fan_out: { status: "observed_uses_only", read_with: "morrow_read_item_bank_fan_out" },
      });
      expect(questionReport.target).toMatchObject({
        association: expect.stringMatching(/selected course's scoped bank list/),
      });
      expect((questionReport.content_evidence as JsonObject).observed_source_signals).toMatchObject({
        image_tags_without_alt: [{ image_index: 1, image_src_sha256: sha256Text("bank-item.png") }],
      });
      expect(questionReport.remediation).toMatchObject({
        status: "candidate_route_observed",
        upstream_tool: "canvas_item_bank_update_item",
        field: "item",
        image_alt_repair: {
          status: "candidate_route_observed",
          planner: "morrow_plan_item_bank_question_image_alt_repair",
          readiness: "not_established_by_catalog",
        },
      });
      expect(questionReport.upstream_read_provenance).toMatchObject([
        { upstream_read_tool: "canvas_get_single_course_courses" },
        { upstream_read_tool: "canvas_item_bank_get_entry" },
        { upstream_read_tool: "canvas_item_bank_get_item" },
      ]);
      expect(calls.find((call) => call.name === "canvas_item_bank_get_item")?.arguments)
        .toEqual({ course_id: "42", bank_id: "14", item_id: "44", _morrow: { source_binding_id: "selected-source" } });
      expect(calls.find((call) => call.name === "canvas_item_bank_get_entry")?.arguments)
        .toEqual({ course_id: "42", bank_id: "14", bank_entry_id: "26", _morrow: { source_binding_id: "selected-source" } });

      // An entry row that embeds its question resolves through the same rule.
      snapshots.canvas_item_bank_get_entry = { id: "26", entry_type: "Item", data: { item: { id: "44" } } };
      const embedded = await client.callTool({ name: "morrow_audit_course", arguments: itemBankEntryArgs });
      expect((embedded.structuredContent as JsonObject).target).toMatchObject({ item_id: "44", item_sha256: questionDigest });
      expect((embedded.structuredContent as JsonObject).remediation).toMatchObject({
        status: "candidate_route_observed",
        image_alt_repair: { planner: "morrow_plan_item_bank_question_image_alt_repair" },
      });

      // A row that names no question is a row, not a question. It gets no plan.
      snapshots.canvas_item_bank_get_entry = { id: "26", entry_type: "Item", entry: { title: "Bank cells" } };
      const unresolved = await client.callTool({ name: "morrow_audit_course", arguments: itemBankEntryArgs });
      const unresolvedReport = unresolved.structuredContent as JsonObject;
      expect(unresolvedReport.remediation).toEqual({
        status: "blocked_unresolved_entry",
        upstream_tool: "canvas_item_bank_update_item",
        reason: expect.stringMatching(/A list row is not a question/),
      });
      expect(unresolvedReport.target).not.toHaveProperty("item_id");
      expect(unresolvedReport.target).not.toHaveProperty("item_bank_fan_out");
      expect(JSON.stringify(unresolvedReport)).not.toContain("candidate_route_observed");
      expect(JSON.stringify(unresolvedReport)).not.toContain("morrow_plan_item_bank_question_image_alt_repair");

      // A question id this connection cannot read back is not a resolved question either.
      snapshots.canvas_item_bank_get_entry = { id: "26", entry_type: "Item", entry_id: "bank-entry-44" };
      const unreadableId = await client.callTool({ name: "morrow_audit_course", arguments: itemBankEntryArgs });
      expect((unreadableId.structuredContent as JsonObject).remediation).toMatchObject({ status: "blocked_unresolved_entry" });

      snapshots.canvas_item_bank_get_entry = {
        id: "26", entry_type: "Stimulus", entry_id: "44",
        entry: { title: "Bank diagram", body: "<p><img src=\"bank-stimulus.png\"></p>", instructions: "Use the labeled image.", source_url: "https://example.edu/bank-diagram" },
      };
      const stimulus = await client.callTool({ name: "morrow_audit_course", arguments: itemBankEntryArgs });
      const stimulusReport = stimulus.structuredContent as JsonObject;
      expect(stimulusReport.content_evidence).toMatchObject({ status: "observed", field: "entry.body" });
      expect(stimulusReport.remediation).toEqual({
        status: "blocked_current_contract",
        upstream_tool: "canvas_item_bank_update_item",
        reason: expect.stringMatching(/checked its harvested New Quizzes and Item Banks sources for a stimulus contract and found none/),
      });
      expect(JSON.stringify(stimulusReport)).not.toContain("candidate_route_observed");

      snapshots.canvas_item_bank_get_entry = { id: "26", entry_type: "QuestionGroup", entry_id: "44", entry: { title: "Membrane group" } };
      const group = await client.callTool({ name: "morrow_audit_course", arguments: itemBankEntryArgs });
      expect((group.structuredContent as JsonObject).remediation).toEqual({
        status: "blocked_current_contract",
        upstream_tool: "canvas_item_bank_update_item",
        reason: expect.stringMatching(/not a question entry/),
      });

      // Every read after the first question audit went to the entry row alone.
      expect(calls.filter((call) => call.name === "canvas_item_bank_get_entry")).toHaveLength(6);
      expect(calls.filter((call) => call.name === "canvas_item_bank_get_item")).toHaveLength(2);

      snapshots.canvas_item_bank_get_entry = { id: "26", entry_type: "Item", entry_id: "44", entry: { title: "Bank cells" } };
      writeTools.delete("canvas_item_bank_update_item");
      const withoutRoute = await client.callTool({ name: "morrow_audit_course", arguments: itemBankEntryArgs });
      expect((withoutRoute.structuredContent as JsonObject).remediation).toMatchObject({
        status: "blocked_current_catalog",
        upstream_tool: "canvas_item_bank_update_item",
        field: "item",
        image_alt_repair: { status: "blocked_current_catalog" },
      });
    } finally { await client.close(); await server.close(); }
  });

  it("reads the course syllabus and rubric criteria without ever requesting rubric assessments", async () => {
    const { runtime, calls, snapshots, writeSchemas } = fixture();
    const client = new Client({ name: "course-audit-learner-surfaces", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    try {
      const guidance = await client.readResource({ uri: "morrow://guidance/course-audit-v1" });
      expect(JSON.stringify(guidance.contents)).toContain("the course syllabus");
      expect(JSON.stringify(guidance.contents)).toContain("never requests rubric assessments");

      const syllabus = await client.callTool({ name: "morrow_audit_course", arguments: syllabusArgs });
      expect(syllabus.isError, JSON.stringify(syllabus.content)).not.toBe(true);
      const syllabusReport = syllabus.structuredContent as JsonObject;
      expect(syllabusReport).toMatchObject({
        status: "evidence_ready",
        course: { id: "42", name: "Biology" },
        target: { kind: "syllabus", id: "42", title: "Biology", course_association: "observed_by_course_scoped_read" },
        content_evidence: { status: "observed", field: "syllabus_body", content: syllabusBody, sha256: sha256Text(syllabusBody) },
        remediation: { status: "candidate_route_observed", upstream_tool: "canvas_update_course", field: "course_syllabus_body", readiness: "not_established_by_catalog" },
      });
      expect((syllabusReport.content_evidence as JsonObject).observed_source_signals).toMatchObject({
        image_tags_without_alt: [{ image_index: 1, image_src_sha256: sha256Text("policy.png") }],
        heading_level_jumps: [{ heading_index: 2, from_level: 1, to_level: 3 }],
      });
      const courseReads = calls.filter((call) => call.name === "canvas_get_single_course_courses");
      expect(courseReads).toHaveLength(2);
      expect(courseReads[0]!.arguments).not.toHaveProperty("include");
      expect(courseReads[1]!.arguments).toMatchObject({ id: "42", include: ["syllabus_body"] });

      delete (snapshots.canvas_get_single_course_courses as JsonObject).syllabus_body;
      const withoutBody = await client.callTool({ name: "morrow_audit_course", arguments: syllabusArgs });
      expect(withoutBody.isError, JSON.stringify(withoutBody.content)).not.toBe(true);
      expect(withoutBody.structuredContent).toMatchObject({
        status: "evidence_incomplete",
        content_evidence: { status: "not_observed", field: "syllabus_body" },
      });
      expect(JSON.stringify(withoutBody.structuredContent)).not.toContain("evidence_ready");
      (snapshots.canvas_get_single_course_courses as JsonObject).syllabus_body = syllabusBody;

      delete ((writeSchemas.canvas_update_course as JsonObject).properties as JsonObject).course_syllabus_body;
      const withoutRoute = await client.callTool({ name: "morrow_audit_course", arguments: syllabusArgs });
      expect((withoutRoute.structuredContent as JsonObject).remediation).toMatchObject({
        status: "blocked_current_contract",
        upstream_tool: "canvas_update_course",
        field: "course_syllabus_body",
        reason: expect.stringMatching(/does not expose the course syllabus body field/),
      });

      const rubric = await client.callTool({ name: "morrow_audit_course", arguments: rubricArgs });
      expect(rubric.isError, JSON.stringify(rubric.content)).not.toBe(true);
      const rubricReport = rubric.structuredContent as JsonObject;
      expect(rubricReport).toMatchObject({
        status: "evidence_incomplete",
        target: { kind: "rubric", id: "28", title: "Lab report rubric", course_association: "observed_by_course_scoped_read" },
        content_evidence: { status: "observed", field: "title", content: "Lab report rubric" },
        remediation: { status: "blocked_current_contract", upstream_tool: "canvas_update_single_rubric", reason: expect.stringMatching(/untyped indexed hash/) },
      });
      const rubricEvidence = rubricReport.assessment_evidence as JsonObject;
      expect(rubricEvidence).toMatchObject({
        disposition: "untrusted_course_content",
        criteria: { status: "observed", field: "data" },
        truncation: { status: "observed", truncated: false },
        learner_assessment_data: { status: "not_requested", fields: ["assessments"] },
      });
      expect(rubricEvidence.html_fields).toMatchObject({
        media_review: expect.objectContaining({ status: "manual_review_required" }),
        fields: expect.arrayContaining([
          expect.objectContaining({
            field: "data[0].description", status: "observed", sha256: sha256Text("<p>Evidence <img src=\"criterion.png\"></p>"),
            observed_source_signals: expect.objectContaining({ image_tags_without_alt: [{ image_index: 1, image_src_sha256: sha256Text("criterion.png") }] }),
          }),
          expect.objectContaining({
            field: "data[0].long_description", status: "observed",
            observed_source_signals: expect.objectContaining({ heading_level_jumps: [{ heading_index: 2, from_level: 1, to_level: 3 }] }),
          }),
          expect.objectContaining({
            field: "data[0].ratings[0].description", status: "observed",
            observed_source_signals: expect.objectContaining({ tables_without_th: [1] }),
          }),
          expect.objectContaining({ field: "data[0].ratings[1].description", status: "observed", value: "Not yet" }),
        ]),
      });
      const rubricCall = calls.find((call) => call.name === "canvas_get_single_rubric_courses");
      expect(rubricCall?.arguments).toEqual({ course_id: "42", id: "28", _morrow: { source_binding_id: "selected-source" } });
      expect(JSON.stringify(calls)).not.toContain("assessments");
      expect(JSON.stringify(rubricReport)).not.toContain("candidate_route_observed");

      (snapshots.canvas_get_single_rubric_courses as JsonObject).description = "<p>Use this rubric for the lab report.</p>";
      // A tenant that returns assessments unasked must not have them echoed anywhere.
      (snapshots.canvas_get_single_rubric_courses as JsonObject).assessments = [
        { id: "99", user_id: "7", score: 8, comments: "Good work, Jane." },
      ];
      const described = await client.callTool({ name: "morrow_audit_course", arguments: rubricArgs });
      expect((described.structuredContent as JsonObject).content_evidence).toMatchObject({
        status: "observed", field: "description", content: "<p>Use this rubric for the lab report.</p>",
      });
      const describedText = JSON.stringify(described.structuredContent);
      for (const learnerValue of ["Good work, Jane.", "user_id", "\"score\"", "comments"]) {
        expect(describedText).not.toContain(learnerValue);
      }
    } finally { await client.close(); await server.close(); }
  });

  it("routes a Classic Quiz description to the guarded image-alt repair", async () => {
    const { runtime, calls, writeTools } = fixture();
    const client = new Client({ name: "course-audit-classic-quiz", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    try {
      const guidance = JSON.stringify((await client.readResource({ uri: "morrow://guidance/course-audit-v1" })).contents);
      expect(guidance).not.toContain("exposes only notification settings");
      expect(guidance).toContain("quiz[notify_of_update]");
      expect(guidance).toContain("sends only `quiz[description]`, verifies the full protected Quiz state, and reruns the selected image-alt check");

      const result = await client.callTool({ name: "morrow_audit_course", arguments: classicQuizArgs });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      const report = result.structuredContent as JsonObject;
      expect(report).toMatchObject({
        status: "evidence_ready",
        target: { kind: "classic_quiz", id: "12", title: "Cell structure check", course_association: "observed_by_course_scoped_read" },
        content_evidence: { status: "observed", field: "description", content: classicQuizDescription, sha256: sha256Text(classicQuizDescription) },
        remediation: {
          status: "candidate_route_observed",
          upstream_tool: "canvas_edit_quiz",
          field: "quiz_description",
          readiness: "not_established_by_catalog",
          image_alt_repair: {
            status: "candidate_route_observed",
            planner: "morrow_plan_classic_quiz_description_image_alt_repair",
            required_audit_evidence: ["content_evidence.sha256", "observed_source_signals.image_tags_without_alt[].image_index", "observed_source_signals.image_tags_without_alt[].image_src_sha256"],
            readiness: "not_established_by_catalog",
          },
        },
      });
      expect((report.content_evidence as JsonObject).observed_source_signals).toMatchObject({
        image_tags_without_alt: [{ image_index: 1, image_src_sha256: sha256Text("quiz-diagram.png") }],
      });
      expect(calls.map((call) => call.name)).toEqual(["canvas_get_single_course_courses", "canvas_get_single_quiz"]);
      expect(calls[1]!.arguments).toMatchObject({ course_id: "42", id: "12" });
      expect(JSON.stringify(report)).not.toContain("no description field");

      // A connection without one unambiguous guarded quiz write route blocks the repair instead of naming a planner.
      writeTools.delete("canvas_edit_quiz");
      const withoutRoute = await client.callTool({ name: "morrow_audit_course", arguments: classicQuizArgs });
      expect((withoutRoute.structuredContent as JsonObject).remediation).toMatchObject({
        status: "blocked_current_catalog",
        upstream_tool: "canvas_edit_quiz",
        field: "quiz_description",
        image_alt_repair: { status: "blocked_current_catalog" },
      });
    } finally { await client.close(); await server.close(); }
  });

  it("downgrades Moodle multiple-choice evidence when its choices are truncated", async () => {
    const runtime = moodleFixture();
    const client = new Client({ name: "course-audit-incomplete", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    try {
      const result = await client.callTool({ name: "morrow_audit_course", arguments: moodleQuestionArgs });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      const report = result.structuredContent as JsonObject;
      expect(report.status).toBe("evidence_incomplete");
      expect(report.assessment_evidence).toMatchObject({ status: "evidence_incomplete" });
      expect((report.assessment_evidence as JsonObject).choice_coverage).toMatchObject({ status: "evidence_incomplete" });
      expect(JSON.stringify(report)).not.toContain('\"status\":\"evidence_ready\"');
    } finally { await client.close(); await server.close(); }
  });

  it("reads exact Moodle activity fields without treating an intro as module-wide evidence", async () => {
    const runtime = moodleFixture();
    const client = new Client({ name: "course-audit-moodle-surfaces", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    try {
      const bookIntro = await client.callTool({ name: "morrow_audit_course", arguments: moodleBookIntroArgs });
      expect(bookIntro.isError, JSON.stringify(bookIntro.content)).not.toBe(true);
      expect(bookIntro.structuredContent).toMatchObject({
        status: "evidence_ready",
        target: { kind: "book_intro", id: 10, observation_scope: "exact_book_intro_only" },
        content_evidence: { field: "instructions", content: "<p>Read the handbook introduction.</p>" },
        remediation: { status: "blocked_current_catalog" },
      });
      expect(JSON.stringify(bookIntro.structuredContent)).toContain("not evidence for its posts, entries, pages");

      const chapter = await client.callTool({ name: "morrow_audit_course", arguments: moodleBookChapterArgs });
      expect(chapter.isError, JSON.stringify(chapter.content)).not.toBe(true);
      expect(chapter.structuredContent).toMatchObject({
        status: "evidence_ready",
        target: { kind: "book_chapter", id: 11, observation_scope: "exact_book_chapter_only" },
        content_evidence: { field: "content", content: "<p>The membrane controls transport.</p>" },
      });

      const label = await client.callTool({ name: "morrow_audit_course", arguments: moodleLabelArgs });
      expect(label.isError, JSON.stringify(label.content)).not.toBe(true);
      expect(label.structuredContent).toMatchObject({
        status: "evidence_ready",
        target: { kind: "label", id: 12, observation_scope: "exact_activity_field_only" },
        content_evidence: { field: "content", content: "<p>Welcome to biology.</p>" },
      });
    } finally { await client.close(); await server.close(); }
  });

  it("audits every newly readable Moodle field and states what each target leaves unread", async () => {
    const runtime = moodleFixture();
    const client = new Client({ name: "course-audit-moodle-new-targets", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    try {
      const expected = [
        { target: { kind: "workshop", module_id: 30 }, id: 30, scope: "exact_activity_intro_only", field: "instructions", content: "<p>Read the brief.</p><img src=\"brief.png\">", title: "Peer review", residual: "The submission instructions, the assessment instructions, and the conclusion are separate saved fields" },
        { target: { kind: "h5pactivity", module_id: 31 }, id: 31, scope: "exact_activity_intro_only", field: "instructions", content: "<p>Open the interactive.</p>", title: "Cell explorer", residual: "The H5P package, its interactions, its player, and learner attempts stay unread" },
        { target: { kind: "glossary_entry", module_id: 32, entry_id: 320 }, id: 320, scope: "exact_glossary_entry_only", field: "definition", content: "<p>The organelle that releases energy.</p>", title: "Mitochondrion", residual: "no other entry in the Glossary is read" },
        { target: { kind: "wiki_page", module_id: 33, page_id: 330 }, id: 330, scope: "exact_wiki_page_version_only", field: "content", content: "<h1>Lab safety</h1><h3>Goggles</h3>", title: "Lab safety", residual: "Other pages, other groups' subwikis, and the page history stay unread" },
        { target: { kind: "lesson_page", module_id: 34, page_id: 340 }, id: 340, scope: "exact_lesson_page_contents_only", field: "contents_text", content: "<p>Water moves across the membrane.</p>", title: "Osmosis", residual: "refuses a page whose text carries a file reference" },
        { target: { kind: "feedback_item", module_id: 35, item_id: 352 }, id: 352, scope: "exact_feedback_item_only", field: "text", content: "<p>Rate the lab.</p>", title: "rating", residual: "no learner response is read" },
        { target: { kind: "database_field", module_id: 36, field_id: 362 }, id: 362, scope: "exact_database_field_name_only", field: "name", content: "Habitat photo", title: "Habitat photo", residual: "A plain-text field name carries no HTML, so a silent source scan of it is not a pass" },
      ] as const;
      for (const entry of expected) {
        const result = await client.callTool({
          name: "morrow_audit_course",
          arguments: { provider: "moodle", source_binding_id: "selected-source", course_id: 7, target: entry.target },
        });
        expect(result.isError, `${entry.target.kind}: ${JSON.stringify(result.content)}`).not.toBe(true);
        const report = result.structuredContent as JsonObject;
        expect(report, entry.target.kind).toMatchObject({
          status: "evidence_ready",
          target: { kind: entry.target.kind, id: entry.id, observation_scope: entry.scope, title: entry.title },
          content_evidence: { status: "observed", field: entry.field, content: entry.content, sha256: sha256Text(entry.content) },
          remediation: { status: "blocked_current_catalog" },
        });
        const residual = report.residual_coverage as JsonObject[];
        expect(residual.map((line) => line.category), entry.target.kind).toContain("accessibility_manual_review");
        expect(residual.some((line) => String(line.reason).includes(entry.residual)), `${entry.target.kind} residual coverage`).toBe(true);
        expect(JSON.stringify(report), entry.target.kind).toContain("Saved-source signals cannot establish keyboard behavior");
      }

      // The Workshop intro carries one image with no alt text, so the source scan
      // reports it as a signal and never as a conformance result.
      const workshop = await client.callTool({ name: "morrow_audit_course", arguments: { provider: "moodle", source_binding_id: "selected-source", course_id: 7, target: { kind: "workshop", module_id: 30 } } });
      const evidence = (workshop.structuredContent as JsonObject).content_evidence as JsonObject;
      const observed = evidence.observed_source_signals as JsonObject;
      expect(observed.image_tags_without_alt).toHaveLength(1);
      expect(String(evidence.interpretation)).toContain("do not prove or disprove WCAG conformance");
      // The Workshop read names no native target of its own, so the audit records none.
      expect((workshop.structuredContent as JsonObject).target).toMatchObject({ observed_targets: [] });
    } finally { await client.close(); await server.close(); }
  });

  it("accepts a Moodle child-record read that sends no native write and refuses a partial one", async () => {
    const client = new Client({ name: "course-audit-moodle-read-shape", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(moodleFixture({
      envelopes: { moodle_get_feedback_items: { ok: true, sent: false, complete: false } },
    })), { transport: b });
    await client.connect(a);
    try {
      const partial = await client.callTool({ name: "morrow_audit_course", arguments: { provider: "moodle", source_binding_id: "selected-source", course_id: 7, target: { kind: "feedback_item", module_id: 35, item_id: 351 } } });
      expect(partial.isError).toBe(true);
      expect(partial.structuredContent).toMatchObject({ schema: "morrow.problem.v1", code: "course_audit_unavailable" });
      expect(JSON.stringify(partial.content)).toContain("Moodle did not return a complete readable result.");
    } finally { await client.close(); await server.close(); }
  });

  it("refuses a Moodle child record the exact activity list does not name once", async () => {
    const runtime = moodleFixture({
      snapshots: {
        moodle_get_database_fields: {
          course_id: 7, module_id: 36, database_id: 360, field_count: 2, default_sort_field_id: 361,
          fields: [{ field_id: 361, name: "Specimen name", type: "text" }, { field_id: 361, name: "Specimen name", type: "text" }],
        },
      },
    });
    const client = new Client({ name: "course-audit-moodle-child-binding", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    try {
      const missing = await client.callTool({ name: "morrow_audit_course", arguments: { provider: "moodle", source_binding_id: "selected-source", course_id: 7, target: { kind: "feedback_item", module_id: 35, item_id: 999 } } });
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing.content)).toContain("exactly one saved Feedback question");

      const duplicated = await client.callTool({ name: "morrow_audit_course", arguments: { provider: "moodle", source_binding_id: "selected-source", course_id: 7, target: { kind: "database_field", module_id: 36, field_id: 361 } } });
      expect(duplicated.isError).toBe(true);
      expect(JSON.stringify(duplicated.content)).toContain("exactly one saved Database field");
    } finally { await client.close(); await server.close(); }
  });

  it("accepts an exact readable Moodle True/false question without giving it a remediation route", async () => {
    const runtime = moodleFixture();
    const client = new Client({ name: "course-audit-moodle-question-type", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    try {
      const result = await client.callTool({ name: "morrow_audit_course", arguments: moodleTrueFalseArgs });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        status: "evidence_ready",
        target: { kind: "quiz_question", id: 15 },
        content_evidence: { field: "question_text", content: "<p>Cells have membranes.</p>" },
        assessment_evidence: { question_type: { status: "observed", value: "truefalse" }, choice_coverage: { status: "not_applicable" } },
        remediation: { status: "blocked_current_catalog" },
      });
    } finally { await client.close(); await server.close(); }
  });

  it("keeps nested quiz content but refuses missing or truncated answer evidence", async () => {
    const { runtime, snapshots } = fixture();
    const client = new Client({ name: "course-audit-nested-evidence", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    try {
      const classic = snapshots.canvas_get_single_quiz_question as JsonObject;
      classic.answers = [{ id: "a", answer_text: "Nucleus", answer_weight: 100 }];
      const classicResult = await client.callTool({ name: "morrow_audit_course", arguments: classicQuestionArgs });
      const classicEvidence = ((classicResult.structuredContent as JsonObject).assessment_evidence as JsonObject).html_fields as JsonObject;
      expect(classicEvidence).toMatchObject({
        status: "evidence_incomplete",
        fields: expect.arrayContaining([expect.objectContaining({ field: "answers[0].answer_comments", status: "not_observed" })]),
      });

      const item = snapshots.canvas_get_quiz_item as JsonObject;
      const entry = item.entry as JsonObject;
      entry.interaction_data = { choices: [{ id: "a", itemBody: "<p>Nucleus</p>" }], choices_truncated: true };
      entry.feedback = null;
      entry.answer_feedback = {};
      const truncatedResult = await client.callTool({ name: "morrow_audit_course", arguments: newQuizItemArgs });
      const truncatedEvidence = ((truncatedResult.structuredContent as JsonObject).assessment_evidence as JsonObject).choice_answer_evidence as JsonObject;
      expect(truncatedEvidence).toMatchObject({
        status: "evidence_incomplete",
        truncation: { status: "evidence_incomplete", truncated_fields: ["entry.interaction_data.choices_truncated"] },
      });

      entry.interaction_data = { choices: [{ id: "a" }] };
      const malformedResult = await client.callTool({ name: "morrow_audit_course", arguments: newQuizItemArgs });
      const malformedEvidence = ((malformedResult.structuredContent as JsonObject).assessment_evidence as JsonObject).choice_answer_evidence as JsonObject;
      expect(malformedEvidence).toMatchObject({
        status: "evidence_incomplete",
        selector_state: { status: "manual_review_required", returned_field_count: 0 },
      });
      expect(JSON.stringify(malformedResult.structuredContent)).not.toContain('"status":"evidence_ready"');

      entry.interaction_type_slug = "hot-spot";
      entry.interaction_data = { image_url: "https://media.example.edu/cell.png" };
      const mediaResult = await client.callTool({ name: "morrow_audit_course", arguments: newQuizItemArgs });
      const mediaEvidence = ((mediaResult.structuredContent as JsonObject).assessment_evidence as JsonObject).media as JsonObject;
      expect(mediaEvidence).toMatchObject({
        status: "manual_review_required",
        fields: [expect.objectContaining({ field: "entry.interaction_data.image_url", sha256: sha256Text(JSON.stringify("https://media.example.edu/cell.png")), value: "https://media.example.edu/cell.png" })],
      });
    } finally { await client.close(); await server.close(); }
  });

  it("returns an explicit blocked outcome for every course file it cannot read", async () => {
    const { runtime, snapshots, refusals, calls } = fixture();
    const client = new Client({ name: "course-audit-blocked-files", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    const metadata = snapshots.canvas_get_file_courses as JsonObject;
    const auditFile = async () => await client.callTool({ name: "morrow_audit_course", arguments: fileArgs });
    try {
      metadata.display_name = "Lecture board.png";
      metadata.filename = "lecture-board.png";
      metadata["content-type"] = "image/png";
      metadata.size = 264_192;
      const image = await auditFile();
      expect(image.isError, JSON.stringify(image.content)).not.toBe(true);
      const imageReport = image.structuredContent as JsonObject;
      expect(imageReport).toMatchObject({
        schema: "morrow.course-audit.v1",
        provider: "canvas",
        status: "blocked",
        block_reason: "binary_bytes_not_readable",
        course: { id: "42", name: "Biology" },
        target: { kind: "file", id: "27", title: "Lecture board.png", course_association: "observed_by_course_scoped_read" },
        file_metadata: { status: "observed", id: "27", display_name: "Lecture board.png", size: 264_192, content_type: "image/png" },
        content_evidence: { status: "not_observed", disposition: "untrusted_course_content", field: "content", block_reason: "binary_bytes_not_readable" },
        remediation: { status: "manual_review_required" },
      });
      expect(imageReport.content_evidence).not.toHaveProperty("content");
      expect(JSON.stringify(imageReport)).not.toContain("evidence_ready");
      expect(JSON.stringify(image.content)).toContain("needs manual review");
      expect(calls.map((call) => call.name)).not.toContain("canvas_read_course_file_text");
      expect(calls.map((call) => call.name)).not.toContain("canvas_read_course_file_signals");

      metadata.display_name = "Lab manual.txt";
      metadata.filename = "lab-manual.txt";
      metadata["content-type"] = "text/plain";
      metadata.size = 2 * 1024 * 1024;
      const oversize = await auditFile();
      expect(oversize.isError, JSON.stringify(oversize.content)).not.toBe(true);
      expect(oversize.structuredContent).toMatchObject({
        status: "blocked",
        block_reason: "file_exceeds_byte_limit",
        file_metadata: { status: "observed", size: 2 * 1024 * 1024, content_type: "text/plain" },
        content_evidence: { status: "not_observed", block_reason: "file_exceeds_byte_limit" },
        remediation: { status: "manual_review_required" },
      });
      expect(JSON.stringify(oversize.structuredContent)).not.toContain("evidence_ready");
      expect(calls.map((call) => call.name)).not.toContain("canvas_read_course_file_text");

      metadata.size = Buffer.byteLength(fileText);
      refusals.canvas_read_course_file_text = "canvas_file_storage_access_required";
      const refused = await auditFile();
      expect(refused.isError, JSON.stringify(refused.content)).not.toBe(true);
      const refusedReport = refused.structuredContent as JsonObject;
      expect(refusedReport).toMatchObject({
        status: "blocked",
        block_reason: "file_access_permission_absent",
        content_evidence: { status: "not_observed", block_reason: "file_access_permission_absent" },
        remediation: { status: "manual_review_required" },
      });
      expect((refusedReport.upstream_read_provenance as JsonObject[]).length).toBe(3);
      expect(calls.filter((call) => call.name === "canvas_read_course_file_text").length).toBe(1);

      refusals.canvas_read_course_file_text = "canvas_file_content_utf8_invalid";
      expect((await auditFile()).structuredContent).toMatchObject({ status: "blocked", block_reason: "file_not_utf8_text" });
      refusals.canvas_read_course_file_text = "canvas_file_changed_during_read";
      expect((await auditFile()).structuredContent).toMatchObject({ status: "blocked", block_reason: "file_changed_during_read" });

      refusals.canvas_read_course_file_text = "canvas_file_content_fetch_failed";
      const unmapped = await auditFile();
      expect(unmapped.isError).toBe(true);
      expect(unmapped.structuredContent).toMatchObject({ schema: "morrow.problem.v1", code: "course_audit_unavailable" });
      expect(unmapped.structuredContent).toHaveProperty("detail_digest");

      delete refusals.canvas_read_course_file_text;
      metadata.id = "99";
      const wrongFile = await auditFile();
      expect(wrongFile.isError).toBe(true);
      expect(wrongFile.structuredContent).toMatchObject({ schema: "morrow.problem.v1", code: "course_audit_evidence_integrity" });
    } finally { await client.close(); await server.close(); }
  });

  it("returns structural signals for a document file and never its text", async () => {
    const { runtime, snapshots, refusals, calls } = fixture();
    const client = new Client({ name: "course-audit-file-signals", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    const metadata = snapshots.canvas_get_file_courses as JsonObject;
    const auditFile = async () => await client.callTool({ name: "morrow_audit_course", arguments: fileArgs });
    try {
      metadata.display_name = "Course syllabus.pdf";
      metadata.filename = "course-syllabus.pdf";
      metadata["content-type"] = "application/pdf";
      metadata.size = 264_192;
      const pdf = await auditFile();
      expect(pdf.isError, JSON.stringify(pdf.content)).not.toBe(true);
      const report = pdf.structuredContent as JsonObject;
      expect(report).toMatchObject({
        schema: "morrow.course-audit.v1",
        provider: "canvas",
        status: "evidence_ready",
        course: { id: "42", name: "Biology" },
        target: { kind: "file", id: "27", title: "Course syllabus.pdf", course_association: "observed_by_course_scoped_read" },
        file_metadata: { status: "observed", id: "27", size: 264_192, content_type: "application/pdf" },
        file_signals: { status: "observed", sha256: "c".repeat(64), byte_length: 264_192, ...fileSignals },
        content_evidence: { status: "not_observed", disposition: "untrusted_course_content", field: "content", reason: "document_text_not_read" },
        remediation: { status: "manual_review_required" },
      });
      // The signal route stands in for the text route. It reads the same bytes
      // and returns no words, so no content and no source-signal scan appears.
      expect(report.content_evidence).not.toHaveProperty("content");
      expect(report.content_evidence).not.toHaveProperty("observed_source_signals");
      expect((report.upstream_read_provenance as JsonObject[]).length).toBe(3);
      expect(calls.map((call) => call.name)).not.toContain("canvas_read_course_file_text");
      expect(calls.filter((call) => call.name === "canvas_read_course_file_signals").length).toBe(1);
      expect(JSON.stringify(report)).not.toContain(fileText);
      expect(JSON.stringify(report.limits)).toContain("do not establish document accessibility");

      refusals.canvas_read_course_file_signals = "canvas_file_pdf_encrypted";
      const encrypted = await auditFile();
      expect(encrypted.isError, JSON.stringify(encrypted.content)).not.toBe(true);
      expect(encrypted.structuredContent).toMatchObject({
        status: "blocked",
        block_reason: "pdf_encrypted",
        content_evidence: { status: "not_observed", block_reason: "pdf_encrypted" },
        remediation: { status: "manual_review_required" },
      });
      expect(JSON.stringify(encrypted.structuredContent)).not.toContain("evidence_ready");
      expect(encrypted.structuredContent).not.toHaveProperty("file_signals");

      refusals.canvas_read_course_file_signals = "canvas_file_pdf_structure_not_readable";
      expect((await auditFile()).structuredContent).toMatchObject({ status: "blocked", block_reason: "pdf_structure_not_readable" });

      metadata.display_name = "Week one handout.docx";
      metadata.filename = "week-one-handout.docx";
      metadata["content-type"] = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      refusals.canvas_read_course_file_signals = "canvas_file_office_structure_not_readable";
      expect((await auditFile()).structuredContent).toMatchObject({ status: "blocked", block_reason: "office_structure_not_readable" });

      // A document over the byte limit is decided from metadata alone.
      delete refusals.canvas_read_course_file_signals;
      metadata.size = 2 * 1024 * 1024;
      const attempted = calls.filter((call) => call.name === "canvas_read_course_file_signals").length;
      expect((await auditFile()).structuredContent).toMatchObject({ status: "blocked", block_reason: "file_exceeds_byte_limit" });
      expect(calls.filter((call) => call.name === "canvas_read_course_file_signals").length).toBe(attempted);
    } finally { await client.close(); await server.close(); }
  });

  it("returns digest-bound incomplete evidence for a body over the complete-evidence limit", async () => {
    const { runtime, snapshots } = fixture();
    const client = new Client({ name: "course-audit-oversized-body", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    try {
      const body = `<h1>Cells</h1><p>${"cell content ".repeat(16_000)}</p>`;
      expect(body.length).toBeGreaterThan(120_000);
      snapshots.canvas_show_page_courses = { page_id: "91", url: "cells", title: "Cells", body };
      const result = await client.callTool({ name: "morrow_audit_course", arguments: pageArgs });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      const report = result.structuredContent as JsonObject;
      expect(report.status).toBe("evidence_incomplete");
      expect(report.content_evidence).toEqual({
        status: "not_observed",
        disposition: "untrusted_course_content",
        field: "body",
        reason: "content_exceeds_complete_evidence_limit",
        character_count: body.length,
        character_limit: 120_000,
        sha256: sha256Text(body),
        detail: expect.stringContaining("This is not a passed check."),
      });
      expect(report.content_evidence).not.toHaveProperty("content");
      expect(JSON.stringify(report)).not.toContain("evidence_ready");
      expect(JSON.stringify(report).length).toBeLessThan(10_000);
    } finally { await client.close(); await server.close(); }
  });

  it("reports every saved-source accessibility signal it can read, including an unclosed table", async () => {
    const { runtime, snapshots } = fixture();
    const client = new Client({ name: "course-audit-source-signals", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    try {
      const guidance = JSON.stringify((await client.readResource({ uri: "morrow://guidance/course-audit-v1" })).contents);
      for (const signal of [
        "image_tags_without_alt", "images_marked_decorative_with_alt_text", "heading_level_jumps", "empty_headings",
        "tables_without_th", "tables_without_caption", "table_headers_without_scope", "unclosed_tables",
        "embedded_media_tags", "media_without_caption_track", "autoplay_media",
        "links_without_text", "links_with_url_text", "links_with_generic_text", "iframes_without_title",
        "aria_hidden_on_focusable", "fixed_pixel_widths", "font_tags",
      ]) expect(guidance).toContain(signal);
      expect(guidance).toContain("a signal that needs human review, never a violation");
      expect(guidance).toContain("no signal set here establishes conformance");

      snapshots.canvas_show_page_courses = { page_id: "91", url: "cells", title: "Cells", body: signalPositiveBody };
      const positive = await client.callTool({ name: "morrow_audit_course", arguments: pageArgs });
      expect(positive.isError, JSON.stringify(positive.content)).not.toBe(true);
      const positiveEvidence = (positive.structuredContent as JsonObject).content_evidence as JsonObject;
      expect(positiveEvidence.observed_source_signals).toEqual({
        image_tags_without_alt: [],
        images_marked_decorative_with_alt_text: [{ image_index: 2 }],
        heading_level_jumps: [],
        empty_headings: [{ heading_index: 2, level: 2 }],
        tables_without_th: [],
        tables_without_caption: [1, 2],
        table_headers_without_scope: [{ table_index: 2, header_index: 1 }],
        unclosed_tables: [2],
        embedded_media_tags: [1, 2],
        media_without_caption_track: [{ media_index: 1, tag: "video" }],
        autoplay_media: [{ media_index: 1, tag: "video" }],
        links_without_text: [{ link_index: 3 }],
        links_with_url_text: [{ link_index: 1 }],
        links_with_generic_text: [{ link_index: 2 }],
        iframes_without_title: [1],
        aria_hidden_on_focusable: [{ focusable_index: 4, tag: "button" }],
        fixed_pixel_widths: [{ element_index: 14, tag: "div", width_px: 720 }],
        font_tags: [15],
      });
      expect(positiveEvidence.source_signal_limits).toEqual({ status: "observed", max_entries_per_signal: 100, truncated_signals: [] });
      expect(positiveEvidence.interpretation).toContain("no signal set here establishes conformance");

      snapshots.canvas_show_page_courses = { page_id: "91", url: "cells", title: "Cells", body: signalNegativeBody };
      const negative = await client.callTool({ name: "morrow_audit_course", arguments: pageArgs });
      expect(negative.isError, JSON.stringify(negative.content)).not.toBe(true);
      const negativeEvidence = (negative.structuredContent as JsonObject).content_evidence as JsonObject;
      expect(negativeEvidence.observed_source_signals).toEqual({
        image_tags_without_alt: [],
        images_marked_decorative_with_alt_text: [],
        heading_level_jumps: [],
        empty_headings: [],
        tables_without_th: [],
        tables_without_caption: [],
        table_headers_without_scope: [],
        unclosed_tables: [],
        embedded_media_tags: [1, 2],
        media_without_caption_track: [],
        autoplay_media: [],
        links_without_text: [],
        links_with_url_text: [],
        links_with_generic_text: [],
        iframes_without_title: [],
        aria_hidden_on_focusable: [],
        fixed_pixel_widths: [],
        font_tags: [],
      });
      expect(negativeEvidence.source_signal_limits).toEqual({ status: "observed", max_entries_per_signal: 100, truncated_signals: [] });
    } finally { await client.close(); await server.close(); }
  });

  it("caps every source-signal list and reports the list as incomplete", async () => {
    const { runtime, snapshots } = fixture();
    const client = new Client({ name: "course-audit-signal-cap", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
    try {
      const body = "<a href=\"/unit\">here</a>".repeat(137);
      snapshots.canvas_show_page_courses = { page_id: "91", url: "cells", title: "Cells", body };
      const result = await client.callTool({ name: "morrow_audit_course", arguments: pageArgs });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      const evidence = (result.structuredContent as JsonObject).content_evidence as JsonObject;
      const signals = evidence.observed_source_signals as JsonObject;
      expect((signals.links_with_generic_text as JsonObject[])).toHaveLength(100);
      expect((signals.links_with_generic_text as JsonObject[])[99]).toEqual({ link_index: 100 });
      expect(evidence.source_signal_limits).toEqual({
        status: "evidence_incomplete",
        max_entries_per_signal: 100,
        truncated_signals: [{ signal: "links_with_generic_text", returned_count: 100, total_count: 137 }],
        reason: "A signal list reached this audit's per-signal entry limit, so that list is incomplete for this field.",
      });
    } finally { await client.close(); await server.close(); }
  });
});
