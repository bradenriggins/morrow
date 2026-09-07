# Canvas Course File Coverage

Date: 2026-09-06  
Status: bounded text reads implemented, and bounded structural signal reads for
PDF and Office documents implemented. Native Chrome optional-host denial,
approval, and revocation passed against synthetic hosts in an isolated Chrome
for Testing profile. Document content, other binary formats, and rendered-file
review remain manual.

## Contract

`canvas_read_course_file_text` reads one exact selected Canvas course File only
when the user has enabled course-file reading in Morrow Bridge settings and
Chrome grants optional `https://*/*` host access. The extension does not
request that permission automatically.

Before it reads bytes, the extension injects a MAIN-world check in the bound
Canvas tab. It freshly reads the signed-in profile, the selected course, and
`GET /api/v1/courses/:course_id/files/:file_id`. The result must have the exact
file ID, a version timestamp, a size at most 1 MiB, a supported content type,
and one same-origin Canvas `File.url` path of `/files/:id/download` with a
nonempty `verifier` parameter.

The service worker keeps that signed URL internal. It fetches with
`credentials: "omit"`, `redirect: "follow"`, no caller headers, and
`referrerPolicy: "no-referrer"`. It accepts only a final HTTPS response whose
type exactly matches the fresh File metadata. It caps the stream at 1 MiB,
requires its byte length to equal the metadata size, decodes fatal UTF-8, and
records the SHA-256 digest of those bytes. It then repeats the MAIN-world File
read and refuses a changed ID, size, type, `updated_at`, or `modified_at`.

The returned result contains file metadata, the bounded text, byte count, and
digest. It never contains the signed URL, Canvas cookies, CSRF values, or an
authorization header.

## Permission and redirect boundary

Canvas can redirect a canonical download URL to a separate storage host. The
release manifest grants only loopback host access and declares
`https://*/*` as optional. The service worker checks both
`courseFileStorageAccessEnabled` and
`chrome.permissions.contains({ origins: ["https://*/*"] })` before every
course-file request.

The Chrome for Testing fixture proves two real denied states: no saved opt-in
with no optional-host permission, and a saved opt-in when
`chrome.permissions.contains` returns false. Both refuse the read. It also
proves the bounded result path, canonical URL validation, no returned signed
URL, and an empty Cookie header at the synthetic storage host.

The fixture does **not** prove native optional-host approval. Its positive
branch adds the synthetic storage host as a fixture-only required host
permission and replaces `chrome.permissions.contains` with a test double in
the Settings page and service worker. This lets the bounded read path reach the
synthetic storage server. It is not evidence that Chrome accepted the real
optional `https://*/*` prompt.

## Upload response observer

A reviewed file transfer posts the staged bytes to the Canvas-issued upload URL
from the service worker and has to read that response's `Location` header, which
`fetch` does not expose. The extension uses its static `webRequest` permission
for that one response. Both listeners are registered with the exact upload URL
as their Chrome match pattern, which carries the signed query string, so Chrome
offers the extension no other request. If Chrome refuses that pattern, the
observer falls back to the same host and path with a trailing wildcard; it never
widens to another host. The listeners still compare the exact URL and the
request id, and a second request to the same URL ends the transfer with
`canvas_file_upload_request_ambiguous`.

The Chrome for Testing fixture holds one upload open, records every filter the
observer registers, mirrors each filter with a probe listener, and sends a POST
to the synthetic Canvas host. The probe records the upload URL alone. A separate
control listener registered for that Canvas URL records the POST, so the probe's
silence is a delivered event the filter excluded rather than a dead listener.

## Native Chrome receipt

An isolated Chrome for Testing profile ran a byte-for-byte release-manifest
copy and recorded native optional-host denial, approval, and revocation on
6 September 2026. The receipt is
`output/canvas-file-permission-2026-09-06/native-permission-final-receipt.json`.
It also recorded first-grant course connection opening course selection without
a second click. The companion synthetic browser fixture verified wrong-course
refusal, no storage cookies, learner-data redaction, and UTF-8 BOM decoding.

This is evidence for native Chrome permission behavior with synthetic Canvas
and synthetic storage hosts only. It predates the static `webRequest`
permission for reviewed Canvas uploads, so it does not prove the current
manifest or upload response observer. It is not evidence for a real Canvas
file-storage host, learner rendering, or a final extension package.

## Document structural signals

`canvas_read_course_file_signals` is the second bounded route over the same
bytes. It accepts `application/pdf` and the three OOXML types, and it uses the
same boundary as the text route: the same user opt-in and Chrome file
permission, the same fresh course-scoped metadata check in the bound Canvas tab,
the same 1 MiB cap, the same `credentials: "omit"` fetch of the canonical
download URL, the same exact byte-length match and SHA-256 digest, and the same
second metadata read that must return an unchanged file version.

It returns structural signals only. No file byte, no document word, no
alternative-text value, and no signed URL is in its result.
`connector/extension/src/canvas-file-signals.js` holds the readers. They are
self-contained, add no dependency, and are bounded by a fixed object count, a
fixed inflate budget, a fixed part count, and no recursion. `DecompressionStream`
is a platform API in the service worker and in Node, so Flate streams and zip
parts are inflated inside those bounds.

A PDF reports its `%PDF-` version, page count, `/MarkInfo /Marked true`,
`/StructTreeRoot`, `/Lang` presence with the length of that value, and whether
any page carries a text-showing operator. An Office file reports part presence,
drawing and picture counts with and without a non-empty `descr`, the heading
style levels a DOCX defines, and slide or sheet counts. Every presence signal
is `present`, `absent`, or `not_determinable`: a structure the reader could not
read is never reported as a missing feature.

An encrypted PDF refuses with `canvas_file_pdf_encrypted`. A PDF structure the
reader cannot parse, including an object stream it cannot inflate, refuses with
`canvas_file_pdf_structure_not_readable`. A zip container it cannot open, a
Zip64 package included, refuses with `canvas_file_office_structure_not_readable`.
`packages/mcp-server/src/course-audit.ts` turns each refusal into an explicit
`blocked` audit state with that reason, and a successful read into
`status: "evidence_ready"` with `file_signals` and
`content_evidence.status: "not_observed"`, because the document's words were
never read.

`scripts/test/canvas-file-signals.test.mjs` runs the readers against hand-built
tagged, untagged, image-only, Flate-compressed, encrypted, and unparsable PDFs,
and against DOCX, PPTX, and XLSX packages with and without descriptions. The
Chrome for Testing fixture serves those same bytes from the synthetic storage
host, proves the whole route through the bridge, and proves that no document
word, no file byte, no signed URL, and no storage cookie appears.

While adding this route, the fixture found that every Canvas browser-catalog
operation crashed the service worker's command handling: `courseScopeProblem`
passed those operations to `canvasOperationAdmission`, which reads a Canvas API
route path they do not have. The three course aggregate reads had the same
defect and no bridge-level test. Those routes now bind to the selected course
through their own `course_id` argument.

## Limits

The text route accepts only `text/plain`, `text/html`, and
`application/xhtml+xml`. The signal route accepts only `application/pdf` and the
three OOXML types, and it returns no document text. Image, audio, video,
archive, and other binary formats require manual review. Neither a text source
scan nor a structural signal proves document accessibility, tagging quality,
reading order, file tags, captions, native-viewer behavior, keyboard use,
learner rendering, or WCAG conformance. Both routes are proved against synthetic
Canvas and synthetic storage hosts only; no customer document and no real Canvas
file host has run them, so both stay live-unverified. This work adds no file
edits, uploads, replacements, or Item Bank changes.
