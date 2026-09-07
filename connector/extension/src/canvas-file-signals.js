/**
 * Structural signals for one bounded Canvas course file.
 *
 * The text route decodes a file and returns its words. This route never does.
 * It reads the same bounded bytes and returns counts, presence states, and one
 * language-value length. No byte, no document text, no alternative-text value,
 * and no part content leaves this module.
 *
 * Every reader here is self-contained and bounded: a fixed object count, a
 * fixed inflate budget, a fixed part count, and no recursion. `DecompressionStream`
 * is a platform API in the extension service worker and in Node, so this module
 * adds no dependency. A structure this module cannot parse fails closed to a
 * refusal, never to a guess.
 *
 * Three states carry every presence signal: `present`, `absent`, and
 * `not_determinable`. An unreadable structure is never reported as an absent
 * feature, because "Morrow could not tell" and "the document does not have it"
 * are different facts.
 */

export const CANVAS_FILE_SIGNALS_OPERATION_KEY = "canvas.api.v1.course.file.structure.read.v1";
export const CANVAS_FILE_SIGNALS_TOOL_NAME = "canvas_read_course_file_signals";
export const CANVAS_FILE_SIGNALS_SCHEMA = "morrow.canvas-course-file-signals.v1";
export const CANVAS_FILE_SIGNALS_INTERPRETATION =
  "Structural signals only. They do not establish document accessibility, tagging quality, reading order, or WCAG conformance.";

const PDF_CONTENT_TYPE = "application/pdf";
const OOXML_CONTENT_TYPES = Object.freeze({
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
});

export const CANVAS_FILE_SIGNAL_CONTENT_TYPES = Object.freeze([PDF_CONTENT_TYPE, ...Object.keys(OOXML_CONTENT_TYPES)]);

const MAX_PDF_OBJECTS = 5_000;
const MAX_PDF_OBJECT_STREAMS = 64;
const MAX_PDF_PAGE_STREAMS = 400;
const MAX_INFLATED_BYTES = 8 * 1024 * 1024;
const MAX_PART_BYTES = 4 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 4_096;
const MAX_XML_PARTS = 200;
const MAX_DRAWING_OBJECTS = 5_000;
const DICTIONARY_WINDOW = 8_192;

function normalizedContentType(value) {
  return typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : "";
}

export function canvasFileSignalsContentTypeSupported(value) {
  return CANVAS_FILE_SIGNAL_CONTENT_TYPES.includes(normalizedContentType(value));
}

/**
 * Reads the structural signals for one already-bounded file.
 *
 * @param {Uint8Array} bytes the exact verified file bytes
 * @param {string} contentType the content type the fresh Canvas metadata declared
 * @returns {Promise<{ ok: true, signals: object } | { ok: false, error: string }>}
 */
export async function canvasCourseFileSignals(bytes, contentType) {
  if (!(bytes instanceof Uint8Array)) return { ok: false, error: "canvas_file_signals_bytes_invalid" };
  const type = normalizedContentType(contentType);
  const budget = { remaining: MAX_INFLATED_BYTES };
  const format = OOXML_CONTENT_TYPES[type];
  if (type !== PDF_CONTENT_TYPE && !format) return { ok: false, error: "canvas_file_content_type_unsupported" };
  // These readers parse an untrusted course document. Anything they did not
  // expect ends as the same refusal a malformed structure gets, so a surprise
  // in one document is stated as an unread file and never left as a silence.
  try {
    return type === PDF_CONTENT_TYPE ? await pdfSignals(bytes, budget) : await officeSignals(bytes, format, budget);
  } catch {
    return { ok: false, error: type === PDF_CONTENT_TYPE ? "canvas_file_pdf_structure_not_readable" : "canvas_file_office_structure_not_readable" };
  }
}

function latin1(bytes, start = 0, end = bytes.byteLength) {
  let value = "";
  for (let at = start; at < end; at += 0x8000) {
    value += String.fromCharCode.apply(null, bytes.subarray(at, Math.min(at + 0x8000, end)));
  }
  return value;
}

function utf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

/** Inflates one bounded stream. Returns null for invalid data or a budget overrun. */
async function inflate(bytes, format, budget, limit = MAX_PART_BYTES) {
  const cap = Math.min(limit, budget.remaining);
  if (cap <= 0) return null;
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const reader = source.pipeThrough(new DecompressionStream(format)).getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > cap) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  budget.remaining -= length;
  const value = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return value;
}

function countMatches(value, pattern) {
  let count = 0;
  for (let match = pattern.exec(value); match !== null; match = pattern.exec(value)) count += 1;
  pattern.lastIndex = 0;
  return count;
}

// ---------------------------------------------------------------- PDF

/**
 * Splits the file into its top-level indirect objects. Each entry keeps the
 * dictionary text and the byte range of its stream, because string indexes and
 * byte offsets are the same after a Latin-1 decode.
 */
function pdfObjects(text) {
  const objects = new Map();
  const pattern = /(?:^|[^0-9A-Za-z])(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
  let count = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    count += 1;
    if (count > MAX_PDF_OBJECTS) return null;
    const bodyStart = match.index + match[0].length;
    const closed = text.indexOf("endobj", bodyStart);
    const bodyEnd = closed < 0 ? text.length : closed;
    const body = text.slice(bodyStart, bodyEnd);
    const stream = /\bstream(\r\n|\n|\r)/.exec(body);
    const dictionary = stream ? body.slice(0, stream.index) : body;
    let dataStart = -1;
    let dataEnd = -1;
    if (stream) {
      dataStart = bodyStart + stream.index + stream[0].length;
      const closedStream = text.indexOf("endstream", dataStart);
      dataEnd = closedStream < 0 ? -1 : closedStream;
    }
    objects.set(Number(match[1]), { dictionary, dataStart, dataEnd });
    pattern.lastIndex = bodyEnd;
  }
  return objects;
}

/** The dictionary that encloses one index, found by a bounded balanced scan. */
function enclosingDictionary(text, index) {
  const start = text.lastIndexOf("<<", index);
  if (start < 0 || index - start > DICTIONARY_WINDOW) return "";
  let depth = 0;
  for (let at = start; at < text.length && at - start < DICTIONARY_WINDOW; at += 1) {
    if (text.startsWith("<<", at)) {
      depth += 1;
      at += 1;
      continue;
    }
    if (text.startsWith(">>", at)) {
      depth -= 1;
      at += 1;
      if (depth === 0) return text.slice(start, at + 1);
    }
  }
  return "";
}

/** The decoded bytes of one object's stream, or null when this reader cannot decode it. */
async function pdfStreamBytes(bytes, object, budget) {
  if (object.dataStart < 0 || object.dataEnd <= object.dataStart) return null;
  let end = object.dataEnd;
  const declared = /\/Length\s+(\d{1,9})(?![0-9\s]*R)/.exec(object.dictionary);
  if (declared && object.dataStart + Number(declared[1]) <= object.dataEnd) end = object.dataStart + Number(declared[1]);
  else while (end > object.dataStart && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d)) end -= 1;
  const raw = bytes.subarray(object.dataStart, end);
  const filter = /\/Filter\s*(\/[A-Za-z0-9]+|\[[^\]]*\])/.exec(object.dictionary);
  if (!filter) {
    if (raw.byteLength > budget.remaining) return null;
    budget.remaining -= raw.byteLength;
    return raw;
  }
  const names = filter[1].match(/\/[A-Za-z0-9]+/g) || [];
  if (names.length !== 1 || names[0] !== "/FlateDecode") return null;
  return await inflate(raw, "deflate", budget) ?? await inflate(raw, "deflate-raw", budget);
}

/** The object numbers one page's `/Contents` names, or null when the entry is not a plain reference. */
function pdfContentReferences(dictionary) {
  const direct = /\/Contents\s+(\d{1,10})\s+\d{1,5}\s+R\b/.exec(dictionary);
  if (direct) return [Number(direct[1])];
  const array = /\/Contents\s*\[([^\]]{0,4000})\]/.exec(dictionary);
  if (!array) return null;
  const references = array[1].match(/(\d{1,10})\s+\d{1,5}\s+R\b/g) || [];
  return references.length ? references.map((entry) => Number(/\d+/.exec(entry)[0])) : null;
}

/**
 * Whether one content stream shows text. Literal strings, hex strings, and
 * inline image data are removed first, so bytes inside a scanned image cannot
 * be read as a text operator.
 */
function pdfShowsText(content) {
  const stripped = content
    .replace(/\bBI\b[\s\S]{0,200000}?\bEI\b/g, " ")
    .replace(/\((?:\\[\s\S]|[^\\)])*\)/g, " ")
    .replace(/<[0-9A-Fa-f\s]*>/g, " ");
  return /(?:^|[\s\]}>)])(?:Tj|TJ|'|")(?=$|[\s[(<\/])/.test(stripped);
}

function pdfPresence(dictionary, pattern) {
  return pattern.test(dictionary) ? "present" : "absent";
}

/** `/MarkInfo << /Marked true >>`, following one indirect reference. */
function pdfMarkedState(catalog, objects) {
  const direct = /\/MarkInfo\s*<<([\s\S]{0,2000}?)>>/.exec(catalog);
  if (direct) return /\/Marked\s+true\b/.test(direct[1]) ? "present" : "absent";
  const reference = /\/MarkInfo\s+(\d{1,10})\s+\d{1,5}\s+R\b/.exec(catalog);
  if (!reference) return "absent";
  const target = objects.get(Number(reference[1]));
  if (!target) return "not_determinable";
  return /\/Marked\s+true\b/.test(target.dictionary) ? "present" : "absent";
}

/** `/Lang` presence and the length of its value. The value itself is never returned. */
function pdfLanguage(catalog, objects) {
  const inspect = (dictionary) => {
    const literal = /\/Lang\s*\(((?:\\[\s\S]|[^\\)]){0,200})\)/.exec(dictionary);
    if (literal) return { state: "present", length: literal[1].replace(/\\(.)/g, "$1").length };
    const hex = /\/Lang\s*<([0-9A-Fa-f\s]{0,400})>/.exec(dictionary);
    if (hex) return { state: "present", length: Math.floor(hex[1].replace(/\s/g, "").length / 2) };
    return null;
  };
  const direct = inspect(catalog);
  if (direct) return direct;
  const reference = /\/Lang\s+(\d{1,10})\s+\d{1,5}\s+R\b/.exec(catalog);
  if (!reference) return { state: "absent", length: null };
  const target = objects.get(Number(reference[1]));
  if (!target) return { state: "not_determinable", length: null };
  const resolved = inspect(target.dictionary);
  return resolved ?? { state: "not_determinable", length: null };
}

async function pdfSignals(bytes, budget) {
  const text = latin1(bytes);
  const header = /%PDF-(\d\.\d)/.exec(text.slice(0, 1024));
  if (!header) return { ok: false, error: "canvas_file_pdf_structure_not_readable" };
  if (/\/Encrypt\s*(?:\d{1,10}\s+\d{1,5}\s+R\b|<<)/.test(text)) return { ok: false, error: "canvas_file_pdf_encrypted" };
  const objects = pdfObjects(text);
  if (!objects || objects.size === 0) return { ok: false, error: "canvas_file_pdf_structure_not_readable" };

  const pages = [];
  const objectStreams = [];
  let catalog = "";
  for (const object of objects.values()) {
    if (/\/Type\s*\/Page(?![A-Za-z])/.test(object.dictionary)) pages.push(object);
    if (!catalog && /\/Type\s*\/Catalog\b/.test(object.dictionary)) catalog = object.dictionary;
    if (/\/Type\s*\/ObjStm\b/.test(object.dictionary)) objectStreams.push(object);
  }

  // Modern writers pack the catalog and the page objects into compressed object
  // streams. Inflating them here is bounded and exact; a stream this reader
  // cannot inflate refuses the whole file rather than reporting a short count.
  let compressedPages = 0;
  let inflatedStreams = 0;
  for (const object of objectStreams.slice(0, MAX_PDF_OBJECT_STREAMS)) {
    const data = await pdfStreamBytes(bytes, object, budget);
    if (!data) return { ok: false, error: "canvas_file_pdf_structure_not_readable" };
    inflatedStreams += 1;
    const decoded = latin1(data);
    compressedPages += countMatches(decoded, /\/Type\s*\/Page(?![A-Za-z])/g);
    if (!catalog) {
      const at = decoded.search(/\/Type\s*\/Catalog\b/);
      if (at >= 0) catalog = enclosingDictionary(decoded, at);
    }
  }

  const pageCount = pages.length + compressedPages;
  if (pageCount === 0) return { ok: false, error: "canvas_file_pdf_structure_not_readable" };

  let textDeterminable = compressedPages === 0;
  let pagesWithText = 0;
  let streamsRead = 0;
  for (const page of pages) {
    const references = pdfContentReferences(page.dictionary);
    if (!references) {
      textDeterminable = false;
      continue;
    }
    let shows = false;
    for (const reference of references) {
      if (streamsRead >= MAX_PDF_PAGE_STREAMS) {
        textDeterminable = false;
        break;
      }
      const target = objects.get(reference);
      const data = target ? await pdfStreamBytes(bytes, target, budget) : null;
      streamsRead += 1;
      if (!data) {
        textDeterminable = false;
        continue;
      }
      if (pdfShowsText(latin1(data))) {
        shows = true;
        break;
      }
    }
    if (shows) pagesWithText += 1;
  }

  const language = catalog ? pdfLanguage(catalog, objects) : { state: "not_determinable", length: null };
  return {
    ok: true,
    signals: {
      format: "pdf",
      pdf_version: header[1],
      page_count: pageCount,
      encryption: "absent",
      marked_content_flag: catalog ? pdfMarkedState(catalog, objects) : "not_determinable",
      structure_tree_root: catalog ? pdfPresence(catalog, /\/StructTreeRoot\b/) : "not_determinable",
      document_language: language.state,
      document_language_value_length: language.length,
      text_showing_operators: pagesWithText > 0 ? "present" : textDeterminable ? "absent" : "not_determinable",
      pages_with_text_showing_operators: textDeterminable ? pagesWithText : null,
      object_streams_inflated: inflatedStreams,
      interpretation: CANVAS_FILE_SIGNALS_INTERPRETATION,
    },
  };
}

// ---------------------------------------------------------------- OOXML

/** The zip central directory only. No part is read here. */
function zipEntries(bytes) {
  if (bytes.byteLength < 22) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let directory = -1;
  const earliest = Math.max(0, bytes.byteLength - 66_000);
  for (let at = bytes.byteLength - 22; at >= earliest; at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) {
      directory = at;
      break;
    }
  }
  if (directory < 0) return null;
  const count = view.getUint16(directory + 10, true);
  const size = view.getUint32(directory + 12, true);
  const offset = view.getUint32(directory + 16, true);
  // A Zip64 container states its real sizes in a record this reader does not parse.
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) return null;
  if (count > MAX_ZIP_ENTRIES || offset + size > bytes.byteLength) return null;
  const entries = new Map();
  let at = offset;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > bytes.byteLength || view.getUint32(at, true) !== 0x02014b50) return null;
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const name = utf8(bytes.subarray(at + 46, at + 46 + nameLength));
    if (name === null) return null;
    entries.set(name, {
      method: view.getUint16(at + 10, true),
      compressed: view.getUint32(at + 20, true),
      uncompressed: view.getUint32(at + 24, true),
      localOffset: view.getUint32(at + 42, true),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** One named part as text, or null when it is absent or this reader cannot decode it. */
async function zipPartText(bytes, entries, name, budget) {
  const entry = entries.get(name);
  if (!entry) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (entry.localOffset + 30 > bytes.byteLength || view.getUint32(entry.localOffset, true) !== 0x04034b50) return null;
  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const end = start + entry.compressed;
  if (end > bytes.byteLength || entry.uncompressed > MAX_PART_BYTES) return null;
  if (entry.method === 0) {
    if (entry.compressed > budget.remaining) return null;
    budget.remaining -= entry.compressed;
    return utf8(bytes.subarray(start, end));
  }
  if (entry.method !== 8) return null;
  const data = await inflate(bytes.subarray(start, end), "deflate-raw", budget);
  return data ? utf8(data) : null;
}

/**
 * Counts drawing objects and how many of them carry a non-empty `descr`
 * attribute. Only the counts leave this function; the description text never
 * does.
 */
function drawingAltTextCounts(xml, container, tag) {
  const described = (value) => /\bdescr="\s*[^"\s][^"]*"/.test(value);
  const pattern = new RegExp(`<${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[^>]*>`, "g");
  let total = 0;
  let withDescription = 0;
  if (container === tag) {
    for (let match = pattern.exec(xml); match !== null && total < MAX_DRAWING_OBJECTS; match = pattern.exec(xml)) {
      total += 1;
      if (described(match[0])) withDescription += 1;
    }
    return { total, described: withDescription };
  }
  // One shape holds one naming element. A shape that carries none has no
  // description, so it is counted as a picture without alternative text.
  for (const segment of xml.split(`<${container}`).slice(1, MAX_DRAWING_OBJECTS + 1)) {
    pattern.lastIndex = 0;
    const match = pattern.exec(segment);
    total += 1;
    if (match && described(match[0])) withDescription += 1;
  }
  return { total, described: withDescription };
}

function presenceOf(entries, name) {
  return entries.has(name) ? "present" : "absent";
}

function partNames(entries, pattern) {
  return [...entries.keys()].filter((name) => pattern.test(name)).sort();
}

async function officeSignals(bytes, format, budget) {
  const entries = zipEntries(bytes);
  if (!entries) return { ok: false, error: "canvas_file_office_structure_not_readable" };
  const notDetermined = { status: "not_determinable", total: null, with_description: null, without_description: null };
  const base = {
    format,
    core_properties: presenceOf(entries, "docProps/core.xml"),
    interpretation: CANVAS_FILE_SIGNALS_INTERPRETATION,
  };

  if (format === "docx") {
    const document = await zipPartText(bytes, entries, "word/document.xml", budget);
    const styles = await zipPartText(bytes, entries, "word/styles.xml", budget);
    const counts = document === null ? null : drawingAltTextCounts(document, "wp:docPr", "wp:docPr");
    const levels = styles === null
      ? null
      : [...new Set((styles.match(/w:styleId="Heading([1-9])"/g) || []).map((entry) => Number(/\d/.exec(entry)[0])))].sort();
    return {
      ok: true,
      signals: {
        ...base,
        document_part: presenceOf(entries, "word/document.xml"),
        drawing_alt_text: counts
          ? { status: "observed", total: counts.total, with_description: counts.described, without_description: counts.total - counts.described }
          : notDetermined,
        heading_styles: levels
          ? { status: "observed", defined_levels: levels }
          : { status: "not_determinable", defined_levels: null },
      },
    };
  }

  if (format === "pptx") {
    const slides = partNames(entries, /^ppt\/slides\/slide\d+\.xml$/).slice(0, MAX_XML_PARTS);
    let total = 0;
    let described = 0;
    let determinable = slides.length > 0;
    for (const name of slides) {
      const slide = await zipPartText(bytes, entries, name, budget);
      if (slide === null) {
        determinable = false;
        continue;
      }
      const counts = drawingAltTextCounts(slide, "p:pic", "p:cNvPr");
      total += counts.total;
      described += counts.described;
    }
    return {
      ok: true,
      signals: {
        ...base,
        document_part: presenceOf(entries, "ppt/presentation.xml"),
        slide_count: slides.length,
        picture_alt_text: determinable
          ? { status: "observed", total, with_description: described, without_description: total - described }
          : notDetermined,
      },
    };
  }

  const drawings = partNames(entries, /^xl\/drawings\/drawing\d+\.xml$/).slice(0, MAX_XML_PARTS);
  let total = 0;
  let described = 0;
  let determinable = true;
  for (const name of drawings) {
    const drawing = await zipPartText(bytes, entries, name, budget);
    if (drawing === null) {
      determinable = false;
      continue;
    }
    const counts = drawingAltTextCounts(drawing, "xdr:pic", "xdr:cNvPr");
    total += counts.total;
    described += counts.described;
  }
  return {
    ok: true,
    signals: {
      ...base,
      document_part: presenceOf(entries, "xl/workbook.xml"),
      sheet_count: partNames(entries, /^xl\/worksheets\/sheet\d+\.xml$/).length,
      picture_alt_text: determinable
        ? { status: "observed", total, with_description: described, without_description: total - described }
        : notDetermined,
    },
  };
}
