/**
 * Hand-built Canvas course-file fixtures for the structural signal reader.
 *
 * Each PDF here is a complete file with a real cross-reference table, and each
 * Office fixture is a real zip container, so the readers under test parse the
 * same structures a course file has. They hold no customer document and no
 * copied material: every string is written for this fixture set.
 *
 * The builders live in one module because the Node test and the Chrome for
 * Testing browser fixture must read the exact same bytes.
 */

import { deflateRawSync, deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/**
 * Lays out numbered PDF objects with a valid cross-reference table.
 *
 * @param {readonly string[]} bodies object bodies in order, object 1 first
 * @param {string} trailer extra trailer dictionary entries
 */
function buildPdf(bodies, trailer = "") {
  const parts = [Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  const offsets = [];
  let length = parts[0].byteLength;
  bodies.forEach((body, index) => {
    const chunk = Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, "latin1");
    offsets.push(length);
    parts.push(chunk);
    length += chunk.byteLength;
  });
  const table = [`xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`];
  for (const offset of offsets) table.push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  const tail = Buffer.from(
    `${table.join("")}trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R${trailer} >>\nstartxref\n${length}\n%%EOF\n`,
    "latin1",
  );
  return Buffer.concat([...parts, tail]);
}

/** One stream object with an exact `/Length`, optionally Flate compressed. */
function streamObject(dictionary, data, compress = false) {
  const bytes = compress ? deflateSync(Buffer.from(data, "latin1")) : Buffer.from(data, "latin1");
  const head = `<< ${dictionary}${compress ? " /Filter /FlateDecode" : ""} /Length ${bytes.byteLength} >>\nstream\n`;
  return Buffer.concat([Buffer.from(head, "latin1"), bytes, Buffer.from("\nendstream", "latin1")]).toString("latin1");
}

const PAGE_TEXT = "BT /F1 12 Tf 72 720 Td (Week one reading) Tj ET";
const IMAGE_ONLY = "q 612 0 0 792 0 0 cm /Im0 Do Q";

/** A tagged PDF: marked content, a structure tree, a document language, one page of text. */
export function taggedPdf() {
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /StructTreeRoot 5 0 R /Lang (en-US) >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    streamObject("", PAGE_TEXT),
    "<< /Type /StructTreeRoot /K [] >>",
  ]);
}

/** The same document without any tagging, language, or structure tree, across two pages. */
export function untaggedPdf() {
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    streamObject("", PAGE_TEXT),
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R >>",
    streamObject("", PAGE_TEXT),
  ]);
}

/** A scan: one page whose only content draws an image, so no text operator exists. */
export function imageOnlyPdf() {
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>",
    streamObject("", IMAGE_ONLY),
    streamObject("/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8", "\x00\x40\x80\xff"),
  ]);
}

/** A tagged PDF whose page content is Flate compressed, so the reader has to inflate it. */
export function compressedTextPdf() {
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /StructTreeRoot 5 0 R /Lang (en) >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    streamObject("", PAGE_TEXT, true),
    "<< /Type /StructTreeRoot /K [] >>",
  ]);
}

/** An encrypted PDF: the trailer names an encryption dictionary. */
export function encryptedPdf() {
  return buildPdf(
    [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
      streamObject("", "\x8f\x21\x0c\xbe\x44\x19"),
      "<< /Filter /Standard /V 4 /R 4 /P -1340 /Length 128 >>",
    ],
    " /Encrypt 5 0 R /ID [<0102030405060708090a0b0c0d0e0f10> <0102030405060708090a0b0c0d0e0f10>]",
  );
}

/**
 * A PDF whose objects live in a compressed object stream this reader cannot
 * inflate, because the stream bytes are not valid Flate data.
 */
export function unreadableStructurePdf() {
  const broken = "\x78\x9c\x00\x00\x00\x00\x00\x00\x00\x00";
  return buildPdf([
    streamObject("/Type /ObjStm /N 2 /First 12", broken, false).replace("<< /Type", "<< /Filter /FlateDecode /Type"),
    "<< /Type /XRef /Size 2 >>",
  ]);
}

/** A PDF beyond the bounded compressed-object walk must not report a partial page count. */
export function pdfWithTooManyObjectStreams() {
  return buildPdf(Array.from({ length: 65 }, () => streamObject("/Type /ObjStm /N 0 /First 0", "")));
}

/** A file that claims to be a PDF and carries no object at all. */
export function emptyPdf() {
  return Buffer.from("%PDF-1.4\n%%EOF\n", "latin1");
}

function zip(files) {
  const locals = [];
  const directory = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const raw = Buffer.from(file.data, "utf8");
    const stored = file.stored === true;
    const data = stored ? raw : deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.byteLength, 18);
    local.writeUInt32LE(raw.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.byteLength, 20);
    central.writeUInt32LE(raw.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += local.byteLength + name.byteLength + data.byteLength;
  }
  const body = Buffer.concat(locals);
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.byteLength, 12);
  end.writeUInt32LE(body.byteLength, 16);
  return Buffer.concat([body, central, end]);
}

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';
const CORE_PROPERTIES = '<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">Saved document title</dc:title></cp:coreProperties>';

/** A DOCX with three drawings: two describe themselves, one does not. */
export function docxWithMixedAltText() {
  const document = [
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">',
    '<w:body><w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Diagram 1" descr="A labelled plant cell"/></wp:inline></w:drawing></w:r></w:p>',
    '<w:p><w:r><w:drawing><wp:anchor><wp:docPr id="2" name="Diagram 2" descr=""/></wp:anchor></w:drawing></w:r></w:p>',
    '<w:p><w:r><w:drawing><wp:inline><wp:docPr id="3" name="Diagram 3" descr="A chart of weekly readings"/></wp:inline></w:drawing></w:r></w:p>',
    "</w:body></w:document>",
  ].join("");
  const styles = [
    '<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>',
    "</w:styles>",
  ].join("");
  return zip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES, stored: true },
    { name: "docProps/core.xml", data: CORE_PROPERTIES },
    { name: "word/document.xml", data: document },
    { name: "word/styles.xml", data: styles, stored: true },
  ]);
}

/** A DOCX with one drawing that carries no description and no heading styles. */
export function docxWithoutAltText() {
  const document = [
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">',
    '<w:body><w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Scan"/></wp:inline></w:drawing></w:r></w:p></w:body></w:document>',
  ].join("");
  return zip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES, stored: true },
    { name: "word/document.xml", data: document },
  ]);
}

/** XML permits single-quoted attributes and whitespace around the equals sign. */
export function docxWithSingleQuotedMetadata() {
  const document = [
    "<?xml version='1.0' encoding='UTF-8'?><w:document xmlns:w='http://schemas.openxmlformats.org/wordprocessingml/2006/main' xmlns:wp='http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'>",
    "<w:body><w:p><w:r><w:drawing><wp:inline><wp:docPr id='1' name='Diagram' descr = 'A labelled diagram'/></wp:inline></w:drawing></w:r></w:p></w:body></w:document>",
  ].join("");
  const styles = "<?xml version='1.0' encoding='UTF-8'?><w:styles xmlns:w='http://schemas.openxmlformats.org/wordprocessingml/2006/main'><w:style w:type='paragraph' w:styleId = 'Heading3'/></w:styles>";
  return zip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES, stored: true },
    { name: "word/document.xml", data: document },
    { name: "word/styles.xml", data: styles },
  ]);
}

/** A central directory with two entries for one part is ambiguous and invalid. */
export function officeWithDuplicatePartNames() {
  return zip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES, stored: true },
    { name: "word/document.xml", data: "<w:document/>" },
    { name: "word/document.xml", data: "<w:document><w:body/></w:document>" },
  ]);
}

/** A PPTX with two slides and three pictures, one of which describes itself. */
export function pptxWithMixedAltText() {
  const slide = (pictures) => [
    '<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>',
    pictures,
    "</p:spTree></p:cSld></p:sld>",
  ].join("");
  return zip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES, stored: true },
    { name: "docProps/core.xml", data: CORE_PROPERTIES },
    { name: "ppt/presentation.xml", data: '<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>' },
    {
      name: "ppt/slides/slide1.xml",
      data: slide('<p:pic><p:nvPicPr><p:cNvPr id="2" name="Picture 2" descr="A microscope slide of cells"/></p:nvPicPr></p:pic><p:pic><p:nvPicPr><p:cNvPr id="3" name="Picture 3"/></p:nvPicPr></p:pic>'),
    },
    {
      name: "ppt/slides/slide2.xml",
      data: slide('<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture 4" descr="  "/></p:nvPicPr></p:pic>'),
      stored: true,
    },
  ]);
}

/** The slide count remains exact when the bounded XML inspection cap is exceeded. */
export function pptxOverPartLimit() {
  return zip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES, stored: true },
    { name: "ppt/presentation.xml", data: "<p:presentation/>" },
    ...Array.from({ length: 201 }, (_, index) => ({
      name: `ppt/slides/slide${index + 1}.xml`,
      data: "<p:sld><p:cSld><p:spTree/></p:cSld></p:sld>",
    })),
  ]);
}

/** An XLSX with one drawing part holding two pictures, one described. */
export function xlsxWithMixedAltText() {
  const drawing = [
    '<?xml version="1.0" encoding="UTF-8"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing">',
    '<xdr:twoCellAnchor><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="1" name="Chart" descr="Weekly attendance chart"/></xdr:nvPicPr></xdr:pic></xdr:twoCellAnchor>',
    '<xdr:twoCellAnchor><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Logo"/></xdr:nvPicPr></xdr:pic></xdr:twoCellAnchor>',
    "</xdr:wsDr>",
  ].join("");
  return zip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES, stored: true },
    { name: "docProps/core.xml", data: CORE_PROPERTIES },
    { name: "xl/workbook.xml", data: '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>' },
    { name: "xl/worksheets/sheet1.xml", data: '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>' },
    { name: "xl/drawings/drawing1.xml", data: drawing },
  ]);
}

/** An Office file whose zip central directory is gone. */
export function truncatedOfficeFile() {
  const value = docxWithMixedAltText();
  return value.subarray(0, Math.floor(value.byteLength / 2));
}
