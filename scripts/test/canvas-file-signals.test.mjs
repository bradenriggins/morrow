import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CANVAS_FILE_SIGNALS_INTERPRETATION,
  CANVAS_FILE_SIGNALS_OPERATION_KEY,
  CANVAS_FILE_SIGNALS_TOOL_NAME,
  canvasCourseFileSignals,
  canvasFileSignalsContentTypeSupported,
} from "../../connector/extension/src/canvas-file-signals.js";
import {
  compressedTextPdf,
  docxWithMixedAltText,
  docxWithoutAltText,
  emptyPdf,
  encryptedPdf,
  imageOnlyPdf,
  pptxWithMixedAltText,
  taggedPdf,
  truncatedOfficeFile,
  unreadableStructurePdf,
  untaggedPdf,
  xlsxWithMixedAltText,
} from "../../packages/mcp-server/test/fixtures/canvas-files/index.mjs";

const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Every word the fixture documents carry. None of them may reach a signal set. */
const FIXTURE_WORDS = [
  "Week one reading", "Saved document title", "A labelled plant cell", "A chart of weekly readings",
  "A microscope slide of cells", "Weekly attendance chart", "Diagram", "Picture", "Logo", "Chart", "Scan",
];

async function signals(bytes, contentType) {
  const result = await canvasCourseFileSignals(new Uint8Array(bytes), contentType);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.signals;
}

async function refusal(bytes, contentType) {
  const result = await canvasCourseFileSignals(new Uint8Array(bytes), contentType);
  assert.equal(result.ok, false, JSON.stringify(result));
  return result.error;
}

test("only PDF and the three OOXML types are accepted for a signal read", () => {
  for (const type of [PDF, DOCX, PPTX, XLSX, "APPLICATION/PDF; charset=binary"]) {
    assert.equal(canvasFileSignalsContentTypeSupported(type), true, type);
  }
  for (const type of ["text/plain", "text/html", "application/xhtml+xml", "image/png", "application/zip", "", null]) {
    assert.equal(canvasFileSignalsContentTypeSupported(type), false, String(type));
  }
});

test("a tagged PDF reports its version, tagging, structure tree, language, and page text", async () => {
  assert.deepEqual(await signals(taggedPdf(), PDF), {
    format: "pdf",
    pdf_version: "1.7",
    page_count: 1,
    encryption: "absent",
    marked_content_flag: "present",
    structure_tree_root: "present",
    document_language: "present",
    document_language_value_length: 5,
    text_showing_operators: "present",
    pages_with_text_showing_operators: 1,
    object_streams_inflated: 0,
    interpretation: CANVAS_FILE_SIGNALS_INTERPRETATION,
  });
});

test("an untagged PDF reports every missing structure as absent, not as unknown", async () => {
  assert.deepEqual(await signals(untaggedPdf(), PDF), {
    format: "pdf",
    pdf_version: "1.7",
    page_count: 2,
    encryption: "absent",
    marked_content_flag: "absent",
    structure_tree_root: "absent",
    document_language: "absent",
    document_language_value_length: null,
    text_showing_operators: "present",
    pages_with_text_showing_operators: 2,
    object_streams_inflated: 0,
    interpretation: CANVAS_FILE_SIGNALS_INTERPRETATION,
  });
});

test("an image-only PDF reports no text-showing operator on any page", async () => {
  const value = await signals(imageOnlyPdf(), PDF);
  assert.equal(value.text_showing_operators, "absent");
  assert.equal(value.pages_with_text_showing_operators, 0);
  assert.equal(value.page_count, 1);
  assert.equal(value.marked_content_flag, "absent");
});

test("a Flate compressed page stream is inflated before the text check", async () => {
  const value = await signals(compressedTextPdf(), PDF);
  assert.equal(value.text_showing_operators, "present");
  assert.equal(value.pages_with_text_showing_operators, 1);
  assert.equal(value.document_language_value_length, 2);
});

test("an encrypted PDF is refused instead of guessed", async () => {
  assert.equal(await refusal(encryptedPdf(), PDF), "canvas_file_pdf_encrypted");
});

test("a PDF structure this reader cannot parse fails closed", async () => {
  assert.equal(await refusal(unreadableStructurePdf(), PDF), "canvas_file_pdf_structure_not_readable");
  assert.equal(await refusal(emptyPdf(), PDF), "canvas_file_pdf_structure_not_readable");
  assert.equal(await refusal(Buffer.from("not a document at all"), PDF), "canvas_file_pdf_structure_not_readable");
});

test("a DOCX reports drawing description counts and heading style levels", async () => {
  assert.deepEqual(await signals(docxWithMixedAltText(), DOCX), {
    format: "docx",
    core_properties: "present",
    document_part: "present",
    drawing_alt_text: { status: "observed", total: 3, with_description: 2, without_description: 1 },
    heading_styles: { status: "observed", defined_levels: [1, 2] },
    interpretation: CANVAS_FILE_SIGNALS_INTERPRETATION,
  });
  assert.deepEqual(await signals(docxWithoutAltText(), DOCX), {
    format: "docx",
    core_properties: "absent",
    document_part: "present",
    drawing_alt_text: { status: "observed", total: 1, with_description: 0, without_description: 1 },
    heading_styles: { status: "not_determinable", defined_levels: null },
    interpretation: CANVAS_FILE_SIGNALS_INTERPRETATION,
  });
});

test("a PPTX counts every picture shape and the ones that describe themselves", async () => {
  assert.deepEqual(await signals(pptxWithMixedAltText(), PPTX), {
    format: "pptx",
    core_properties: "present",
    document_part: "present",
    slide_count: 2,
    picture_alt_text: { status: "observed", total: 3, with_description: 1, without_description: 2 },
    interpretation: CANVAS_FILE_SIGNALS_INTERPRETATION,
  });
});

test("an XLSX counts its sheets and its drawing descriptions", async () => {
  assert.deepEqual(await signals(xlsxWithMixedAltText(), XLSX), {
    format: "xlsx",
    core_properties: "present",
    document_part: "present",
    sheet_count: 1,
    picture_alt_text: { status: "observed", total: 2, with_description: 1, without_description: 1 },
    interpretation: CANVAS_FILE_SIGNALS_INTERPRETATION,
  });
});

test("an Office container this reader cannot open fails closed", async () => {
  assert.equal(await refusal(truncatedOfficeFile(), DOCX), "canvas_file_office_structure_not_readable");
  assert.equal(await refusal(Buffer.from("PK truncated"), PPTX), "canvas_file_office_structure_not_readable");
});

test("a signal set carries no document text and no description value", async () => {
  const sets = [
    await signals(taggedPdf(), PDF),
    await signals(untaggedPdf(), PDF),
    await signals(compressedTextPdf(), PDF),
    await signals(docxWithMixedAltText(), DOCX),
    await signals(pptxWithMixedAltText(), PPTX),
    await signals(xlsxWithMixedAltText(), XLSX),
  ];
  const serialized = JSON.stringify(sets);
  for (const word of FIXTURE_WORDS) assert.equal(serialized.includes(word), false, `signal set leaked ${word}`);
  assert.equal(/%PDF|<w:|<p:|PK/.test(serialized), false, "signal set carried file bytes");
});

test("an unexpected reader failure ends as a refusal, never as a thrown error", async () => {
  const unreadable = (build) => {
    const value = new Uint8Array(build());
    Object.defineProperty(value, "byteLength", { get() { throw new Error("reader failure"); } });
    return value;
  };
  assert.deepEqual(await canvasCourseFileSignals(unreadable(taggedPdf), PDF), { ok: false, error: "canvas_file_pdf_structure_not_readable" });
  assert.deepEqual(await canvasCourseFileSignals(unreadable(docxWithMixedAltText), DOCX), { ok: false, error: "canvas_file_office_structure_not_readable" });
});

test("an unsupported type and invalid bytes are refused before any parse", async () => {
  assert.equal(await refusal(taggedPdf(), "text/plain"), "canvas_file_content_type_unsupported");
  const invalid = await canvasCourseFileSignals("not bytes", PDF);
  assert.deepEqual(invalid, { ok: false, error: "canvas_file_signals_bytes_invalid" });
});

test("the signal route is cataloged, routed by the worker, and shipped in the extension bundle", () => {
  const root = new URL("../../", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/canvas-browser-catalog.json", root), "utf8"));
  const entries = catalog.operations.filter((entry) => entry.key === CANVAS_FILE_SIGNALS_OPERATION_KEY);
  assert.equal(entries.length, 1, "the signal route must be cataloged once");
  assert.equal(entries[0].toolName, CANVAS_FILE_SIGNALS_TOOL_NAME);
  assert.equal(entries[0].provider, "canvas");
  assert.equal(entries[0].readOnly, true);
  assert.equal(entries[0].inputSchema.additionalProperties, false);
  assert.deepEqual(entries[0].inputSchema.required, ["course_id", "file_id"]);
  assert.ok(entries[0].description.includes("never returns file bytes"));
  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{[^}]*canvasCourseFileSignals[^}]*\} from "\.\/canvas-file-signals\.js";/);
  assert.match(worker, /operation\.key === CANVAS_FILE_SIGNALS_OPERATION_KEY/);
  const bundle = readFileSync(new URL("scripts/package-mcp-bundle.mjs", root), "utf8");
  assert.ok(bundle.includes('"src/canvas-file-signals.js"'), "the signal reader must ship in the extension bundle");
});
