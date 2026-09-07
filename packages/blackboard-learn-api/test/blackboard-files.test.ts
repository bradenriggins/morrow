import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { deriveBlackboardSourceBindingId } from "../src/binding.js";
import { signBlackboardEffectGrant, type BlackboardEffectGrant } from "../src/effect-grant.js";
import { BlackboardLearnRuntime } from "../src/runtime.js";
import { createBlackboardLearnMcpServer } from "../src/server.js";
import type { BlackboardTenant } from "../src/types.js";

const courseId = "_22_1";
const documentId = "_33_1";
const folderId = "_100_1";
const wrapperId = "_101_1";
const principalId = "_11_1";
const studentId = "_44_1";
const effectSecret = Buffer.alloc(32, 5).toString("base64url");
const uploadsPath = "/learn/api/public/v1/uploads";
const attachmentsPath = `/learn/api/public/v1/courses/${courseId}/contents/${documentId}/attachments`;
const rosterPath = `/learn/api/public/v1/courses/${courseId}/users`;

/** The one reviewed file: its bytes, and the manifest a plan and an approval carry. */
const fileBytes = Buffer.from("Morrow attachment fixture bytes for Blackboard.\n", "utf8");
const fileBase64 = fileBytes.toString("base64");
const fileDigest = createHash("sha256").update(fileBytes).digest("hex");
const filename = "Week 1 handout.txt";
const contentType = "text/plain";

const manifest = {
  filename,
  size_bytes: fileBytes.byteLength,
  sha256: fileDigest,
  content_type: contentType,
};

const privateAttachment = {
  schema: "morrow.private-file-attachment.v1",
  handle: "file:0f2a5f3e-2a1e-4a1e-9b9a-1f2a3b4c5d6e",
  manifest: { filename, size_bytes: fileBytes.byteLength, sha256: fileDigest },
  content_type: contentType,
  bytes_base64: fileBase64,
};

/** One roster: the account this credential acts as, and one enrolled learner. */
const roster: readonly JsonObject[] = [
  {
    id: "_m10_1", courseId, userId: principalId, courseRoleId: "Instructor", availability: { available: "Yes" },
    user: { id: principalId, name: { given: "Ada", family: "Byron" }, contact: { email: "ada.byron@example.edu" }, userName: "ada.byron" },
  },
  {
    id: "_m11_1", courseId, userId: studentId, courseRoleId: "Student", availability: { available: "Yes" },
    user: { id: studentId, name: { given: "Jane", family: "Doe" }, contact: { email: "jane.doe@example.edu" }, userName: "jane.doe" },
  },
];

let close: (() => Promise<void>) | undefined;

afterEach(async () => { await close?.(); close = undefined; });

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function structured(result: unknown): JsonObject {
  if (!isJsonObject(result) || !isJsonObject(result.structuredContent)) {
    throw new Error("The Blackboard tool returned no structured result.");
  }
  return result.structuredContent;
}

function summary(result: unknown): string {
  const content = isJsonObject(result) && Array.isArray(result.content) ? result.content[0] : undefined;
  return isJsonObject(content) && typeof content.text === "string" ? content.text : "";
}

function rows(value: unknown): readonly JsonObject[] {
  if (!Array.isArray(value) || value.some((entry) => !isJsonObject(entry))) {
    throw new Error("The Blackboard result did not carry a list of records.");
  }
  return value as readonly JsonObject[];
}

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/** The one file part of a `multipart/form-data` request, as the tenant received it. */
function multipartFile(raw: Buffer, contentTypeHeader: string): { readonly headers: string; readonly bytes: Buffer } {
  const boundary = /boundary=("?)([^";]+)\1/.exec(contentTypeHeader)?.[2];
  if (!boundary) throw new Error(`the upload request is not multipart: ${contentTypeHeader}`);
  const opening = raw.indexOf(`--${boundary}\r\n`);
  const separator = raw.indexOf("\r\n\r\n", opening);
  const closing = raw.indexOf(`\r\n--${boundary}--`, separator);
  if (opening !== 0 || separator < 0 || closing < 0) throw new Error("the upload request has no single file part");
  return {
    headers: raw.subarray(opening, separator).toString("utf8"),
    bytes: raw.subarray(separator + 4, closing),
  };
}

interface UploadRecord {
  readonly contentType: string;
  readonly headers: string;
  readonly bytes: Buffer;
}

interface FixtureOptions {
  /** Answer the upload route with this status instead of staging the file. */
  readonly uploadStatus?: number;
  /** Answer the upload route without naming the staged file. */
  readonly uploadWithoutId?: boolean;
  /** Answer the attach request without naming the file it created. */
  readonly attachWithoutId?: boolean;
  /** Report no size on the attached file, as a tenant that does not return one. */
  readonly attachWithoutSize?: boolean;
  /** Answer the readback with this file name instead of the one that was attached. */
  readonly readbackFileName?: string;
  /** Answer the readback with this size instead of the size of the attached file. */
  readbackSize?: number;
  /** Start with a file of the reviewed name already on the item. */
  readonly duplicateName?: boolean;
  /** Add one file to the item between the plan's read and the dispatch's read. */
  readonly attachBetweenReads?: boolean;
  /** Answer the content read with this handler instead of a document. */
  readonly contentHandler?: JsonObject;
}

async function harness(options: FixtureOptions = {}) {
  const requests: string[] = [];
  const uploads: UploadRecord[] = [];
  const attachRequests: JsonObject[] = [];
  let attachmentListReads = 0;
  const attachments = new Map<string, JsonObject>([
    ["att-1", { id: "att-1", fileName: "Syllabus notes.txt", mimeType: "text/plain", size: 24 }],
    // Blackboard does not promise a size on every attachment record.
    ["att-2", { id: "att-2", fileName: "Feedback for Jane Doe.txt", mimeType: "text/plain" }],
  ]);
  if (options.duplicateName) attachments.set("att-9", { id: "att-9", fileName: filename, mimeType: "text/plain" });
  const content = new Map<string, JsonObject>([
    [documentId, {
      id: documentId, courseId, parentId: "_55_1", title: "Week 1", position: 1,
      contentHandler: options.contentHandler || { id: "resource/x-bb-document" },
      availability: { available: "Yes" },
    }],
    [folderId, {
      id: folderId, courseId, title: "Module 1", position: 2,
      contentHandler: { id: "resource/x-bb-folder" }, availability: { available: "Yes" },
    }],
    [wrapperId, {
      id: wrapperId, courseId, title: "Ultra document", position: 3,
      contentHandler: { id: "resource/x-bb-folder", isBbPage: true }, availability: { available: "Yes" },
    }],
  ]);
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url || "/", "http://fixture");
    const pathname = url.pathname;
    requests.push(`${request.method} ${pathname}`);
    if (pathname === "/learn/api/public/v1/oauth2/token") { json(response, { access_token: "temporary-token", expires_in: 3600 }); return; }
    if (pathname === "/learn/api/public/v1/users/me") { json(response, { id: principalId }); return; }
    if (pathname === `/learn/api/public/v1/users/${principalId}`) { json(response, { id: principalId }); return; }
    if (pathname === `${rosterPath}/${principalId}`) { json(response, { id: "_m10_1", courseId, userId: principalId }); return; }
    if (pathname === rosterPath) { json(response, { results: roster, paging: {} }); return; }
    if (pathname === `/learn/api/public/v3/courses/${courseId}`) {
      json(response, { id: courseId, courseId: "BIO-101", name: "Biology", ultraStatus: "Ultra", closedComplete: false }); return;
    }
    if (pathname === uploadsPath && request.method === "POST") {
      void body(request).then((raw) => {
        const header = request.headers["content-type"] || "";
        uploads.push({ contentType: header, ...multipartFile(raw, header) });
        if (options.uploadStatus) { json(response, { message: "refused" }, options.uploadStatus); return; }
        json(response, options.uploadWithoutId ? { message: "stored" } : { id: "upload-1" }, 201);
      });
      return;
    }
    if (pathname === attachmentsPath && request.method === "POST") {
      void body(request).then((raw) => {
        const requested = JSON.parse(raw.toString("utf8")) as JsonObject;
        attachRequests.push(requested);
        const created: JsonObject = {
          id: "att-3",
          fileName: typeof requested.fileName === "string" ? requested.fileName : "",
          mimeType: contentType,
          ...(options.attachWithoutSize ? {} : { size: fileBytes.byteLength }),
        };
        attachments.set("att-3", created);
        json(response, options.attachWithoutId ? { message: "attached" } : created, 201);
      });
      return;
    }
    if (pathname === attachmentsPath) {
      json(response, { results: [...attachments.values()], paging: {} });
      // Someone else adds a file to this item after Morrow froze the plan.
      attachmentListReads += 1;
      if (options.attachBetweenReads && attachmentListReads === 1) {
        attachments.set("att-8", { id: "att-8", fileName: "Added by someone else.txt", mimeType: "text/plain" });
      }
      return;
    }
    const one = new RegExp(`^${attachmentsPath}/([^/]+)$`).exec(pathname);
    if (one && attachments.has(one[1] || "")) {
      const record = { ...attachments.get(one[1] || "")! };
      if (options.readbackFileName !== undefined) record.fileName = options.readbackFileName;
      if (options.readbackSize !== undefined) record.size = options.readbackSize;
      json(response, record); return;
    }
    const item = /^\/learn\/api\/public\/v1\/courses\/([^/]+)\/contents\/([^/]+)$/.exec(pathname);
    if (item && item[1] === courseId && content.has(item[2] || "")) { json(response, content.get(item[2] || "")); return; }
    json(response, { message: "not found" }, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test fixture address missing");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const binding = deriveBlackboardSourceBindingId(baseUrl, principalId, courseId);
  const tenant: BlackboardTenant = {
    id: "fixture", baseUrl, applicationKey: "app-key", clientSecret: "client-secret", principalId,
    courseBindings: [{ sourceBindingId: binding, courseId }],
  };
  const runtime = new BlackboardLearnRuntime([tenant], { effectDispatchSecret: effectSecret });
  const client = new Client({ name: "blackboard-files", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  const [left, right] = InMemoryTransport.createLinkedPair();
  const running = serveStdio(() => createBlackboardLearnMcpServer(runtime, { includePrivateDispatch: true }), { transport: right });
  await client.connect(left);
  close = async () => {
    await client.close();
    await running.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const scope = { tenant_id: "fixture", source_binding_id: binding, course_id: courseId };
  // A dispatch must carry the exact connection scope frozen by its own source
  // plan. This fixture retains that scope by digest; it never asks the runtime
  // for a newer session while it builds an apply request.
  const reviewedPlans = new Map<string, { readonly effectScope: JsonObject; readonly expectedConnection: JsonObject }>();
  const call = async (name: string, args: JsonObject = {}) => {
    const planDigest = args.expected_plan_digest;
    const reviewed = typeof planDigest === "string" ? reviewedPlans.get(planDigest) : undefined;
    const request = name.startsWith("blackboard_apply_reviewed_") && reviewed && args.expected_connection === undefined
      ? { ...scope, ...args, expected_connection: reviewed.expectedConnection }
      : { ...scope, ...args };
    const result = await client.callTool({ name, arguments: request });
    const content = isJsonObject(result) && isJsonObject(result.structuredContent) ? result.structuredContent : null;
    const effectScope = content && isJsonObject(content.effect_scope) ? content.effect_scope : null;
    if (content && typeof content.planDigest === "string" && effectScope
      && typeof effectScope.principalFingerprint === "string" && /^[0-9a-f]{64}$/.test(effectScope.principalFingerprint)
      && typeof effectScope.sessionGeneration === "number" && Number.isInteger(effectScope.sessionGeneration) && effectScope.sessionGeneration >= 1) {
      const expectedConnection = Object.freeze({
        principal_fingerprint: effectScope.principalFingerprint,
        session_generation: effectScope.sessionGeneration,
      });
      reviewedPlans.set(content.planDigest, Object.freeze({ effectScope: Object.freeze({ ...effectScope }), expectedConnection }));
    }
    return result;
  };
  return {
    binding,
    requests: () => [...requests],
    posts: () => requests.filter((entry) => entry.startsWith("POST ") && !entry.endsWith("/oauth2/token")),
    uploads: () => [...uploads],
    attachRequests: () => [...attachRequests],
    call,
  };
}

let receipts = 0;

function effectGrant(planDigest: string): BlackboardEffectGrant {
  receipts += 1;
  const unsigned = {
    schema: "morrow.blackboard.effect-grant.v1" as const,
    operationId: "op:blackboard-files-test",
    planDigest,
    outerPlanDigest: "b".repeat(64),
    approvalGrantDigest: "c".repeat(64),
    effectReceiptId: `effect:00000000-0000-4000-8000-${String(receipts).padStart(12, "0")}`,
    dispatchAttempt: 1,
    gatewayProcessId: "gateway:test",
  };
  return { ...unsigned, dispatchToken: signBlackboardEffectGrant(effectSecret, unsigned) };
}

function grantArguments(grant: BlackboardEffectGrant): JsonObject {
  return {
    schema: grant.schema,
    operation_id: grant.operationId,
    plan_digest: grant.planDigest,
    outer_plan_digest: grant.outerPlanDigest,
    approval_grant_digest: grant.approvalGrantDigest,
    effect_receipt_id: grant.effectReceiptId,
    dispatch_attempt: grant.dispatchAttempt,
    gateway_process_id: grant.gatewayProcessId,
    dispatch_token: grant.dispatchToken,
  };
}

/** One approved dispatch of the reviewed file, as the Gateway sends it. */
function applyArguments(planDigest: string, overrides: JsonObject = {}): JsonObject {
  return {
    content_id: documentId,
    ...manifest,
    expected_plan_digest: planDigest,
    privateAttachment,
    _morrow: { outer_grant: grantArguments(effectGrant(planDigest)) },
    ...overrides,
  };
}

async function planDigestOf(fixture: Awaited<ReturnType<typeof harness>>, args: JsonObject = {}): Promise<string> {
  const plan = structured(await fixture.call("blackboard_plan_content_attachment", { content_id: documentId, ...manifest, ...args }));
  if (plan.ok !== true || typeof plan.planDigest !== "string") {
    throw new Error(`the attachment plan was refused: ${JSON.stringify(plan)}`);
  }
  return plan.planDigest;
}

describe("Blackboard files, attachments and uploads", () => {
  it("lists the files on one item and reads one of them, with learner names redacted and an absent size left absent", async () => {
    const fixture = await harness();
    const listed = structured(await fixture.call("blackboard_list_content_attachments", { content_id: documentId }));
    expect(listed).toMatchObject({ ok: true, courseId, contentId: documentId, count: 2, status: "api_configured_live_untested" });
    const attachments = rows(listed.attachments);
    expect(attachments[0]).toEqual({ id: "att-1", fileName: "Syllabus notes.txt", mimeType: "text/plain", size: 24 });
    // Blackboard reported no size for this file, so the result reports none.
    expect(attachments[1]).not.toHaveProperty("size");
    const listedText = JSON.stringify(listed);
    expect(listedText).not.toContain("Jane Doe");
    expect(listedText).toContain("Feedback for");

    // A path segment that would resolve somewhere else is refused before any request.
    const traversal = structured(await fixture.call("blackboard_read_content_attachment", { content_id: documentId, attachment_id: ".." }));
    expect(traversal).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_scope_binding_required" } });

    const one = structured(await fixture.call("blackboard_read_content_attachment", { content_id: documentId, attachment_id: "att-2" }));
    expect(one).toMatchObject({ ok: true, attachmentId: "att-2", sizeReported: false });
    expect(JSON.stringify(one)).not.toContain("Jane Doe");
    expect(summary(await fixture.call("blackboard_list_content_attachments", { content_id: documentId })))
      .toBe("Morrow read the files on the selected Blackboard content item.");
  });

  it("plans one file attachment without staging anything, and freezes the name, size and digest", async () => {
    const fixture = await harness();
    const plan = structured(await fixture.call("blackboard_plan_content_attachment", { content_id: documentId, ...manifest }));
    expect(plan).toMatchObject({
      schema: "morrow.blackboard.content-attachment.plan.v1",
      ok: true,
      courseId,
      contentId: documentId,
      file: { filename, sizeBytes: fileBytes.byteLength, sha256: fileDigest, contentType },
      reviewRequired: true,
      limits: { files: 1, maxBytes: 1024 * 1024 },
      readback: "metadata_only",
      status: "api_configured_live_untested",
    });
    expect(String(plan.planDigest)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(plan.beforeDigest)).toMatch(/^[0-9a-f]{64}$/);
    expect(rows(plan.before).map((entry) => entry.id)).toEqual(["att-1", "att-2"]);
    // A plan sends no change: it reads the item and the files already on it.
    expect(fixture.posts()).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain(fileBase64);
    expect(summary(await fixture.call("blackboard_plan_content_attachment", { content_id: documentId, ...manifest })))
      .toBe("Morrow prepared one Blackboard file attachment for review. No file was staged and none was attached.");
  });

  it("stages the reviewed bytes once, attaches them once, and returns no file bytes", async () => {
    const fixture = await harness();
    const planDigest = await planDigestOf(fixture);
    const result = await fixture.call("blackboard_apply_reviewed_content_attachment", applyArguments(planDigest));
    const readback = structured(result);
    expect(readback).toMatchObject({
      schema: "morrow.blackboard.content-attachment.readback.v1",
      ok: true,
      resultState: "applied",
      courseId,
      contentId: documentId,
      attachmentId: "att-3",
      attachment: { id: "att-3", fileName: filename, mimeType: contentType, size: fileBytes.byteLength },
      file: { filename, sizeBytes: fileBytes.byteLength, sha256: fileDigest },
      verification: { filename: "matched", size: "matched", bytes: "not_compared" },
      readback: "metadata_only",
    });
    expect(String(readback.readbackDetail)).toContain("did not read the file's bytes back");

    // Exactly one upload and one attach request for this one approved plan.
    expect(fixture.posts()).toEqual([`POST ${uploadsPath}`, `POST ${attachmentsPath}`]);
    expect(fixture.attachRequests()).toEqual([{ uploadId: "upload-1", fileName: filename }]);

    // The tenant received the exact reviewed bytes, as one multipart file part.
    const upload = fixture.uploads()[0]!;
    expect(upload.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(upload.headers).toContain(`filename="${filename}"`);
    expect(upload.headers).toContain(contentType);
    expect(createHash("sha256").update(upload.bytes).digest("hex")).toBe(fileDigest);

    // The bytes are in the provider request and nowhere else.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(fileBase64);
    expect(serialized).not.toContain("fixture bytes");
    expect(serialized).not.toContain("bytes_base64");
    expect(serialized).not.toContain("privateAttachment");
  });

  it("reports the size as unreported, and never a byte check, when the tenant returns no size", async () => {
    const fixture = await harness({ attachWithoutSize: true });
    const planDigest = await planDigestOf(fixture);
    const readback = structured(await fixture.call("blackboard_apply_reviewed_content_attachment", applyArguments(planDigest)));
    expect(readback).toMatchObject({
      ok: true,
      resultState: "applied",
      verification: { filename: "matched", size: "unreported", bytes: "not_compared" },
      readback: "metadata_only",
    });
    expect(readback.attachment).not.toHaveProperty("size");
    expect(fixture.posts()).toEqual([`POST ${uploadsPath}`, `POST ${attachmentsPath}`]);
  });

  it("refuses a replayed grant, and sends nothing for it", async () => {
    const fixture = await harness();
    const planDigest = await planDigestOf(fixture);
    const grant = grantArguments(effectGrant(planDigest));
    const first = structured(await fixture.call("blackboard_apply_reviewed_content_attachment", {
      content_id: documentId, ...manifest, expected_plan_digest: planDigest, privateAttachment, _morrow: { outer_grant: grant },
    }));
    expect(first.ok).toBe(true);
    const sent = fixture.posts();

    const replay = structured(await fixture.call("blackboard_apply_reviewed_content_attachment", {
      content_id: documentId, ...manifest, expected_plan_digest: planDigest, privateAttachment, _morrow: { outer_grant: grant },
    }));
    expect(replay).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_patch_review_required", message: "This Blackboard effect grant was already dispatched." },
    });
    expect(fixture.posts()).toEqual(sent);
  });

  it("refuses an oversized file before it stages anything", async () => {
    const fixture = await harness();
    const oversize = 1024 * 1024 + 1;
    const plan = structured(await fixture.call("blackboard_plan_content_attachment", {
      content_id: documentId, ...manifest, size_bytes: oversize,
    }));
    expect(plan).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_operation_unavailable" } });
    expect(String(plan.problem && (plan.problem as JsonObject).message)).toContain("at most 1 MiB");

    // The grant names a real reviewed plan. The invalid file is rejected only
    // after the generic dispatch guard has checked that frozen plan's session.
    const reviewedPlan = await planDigestOf(fixture);
    const dispatch = structured(await fixture.call("blackboard_apply_reviewed_content_attachment", applyArguments(reviewedPlan, {
      size_bytes: oversize,
      privateAttachment: { ...privateAttachment, manifest: { ...privateAttachment.manifest, size_bytes: oversize } },
    })));
    expect(dispatch).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_operation_unavailable" } });
    expect(fixture.uploads()).toEqual([]);
    expect(fixture.attachRequests()).toEqual([]);
  });

  it("refuses bytes that are not the reviewed file, before it stages anything", async () => {
    const fixture = await harness();
    const reviewedPlan = await planDigestOf(fixture);
    const otherBytes = Buffer.from("A different file.\n", "utf8");
    const dispatch = structured(await fixture.call("blackboard_apply_reviewed_content_attachment", applyArguments(reviewedPlan, {
      privateAttachment: { ...privateAttachment, bytes_base64: otherBytes.toString("base64") },
    })));
    expect(dispatch).toMatchObject({
      ok: false, resultState: "not_sent", problem: { code: "blackboard_patch_review_required" },
    });
    expect(String((dispatch.problem as JsonObject).message)).toContain("Nothing was staged and nothing was attached.");
    expect(fixture.uploads()).toEqual([]);
    expect(fixture.attachRequests()).toEqual([]);
  });

  it("reports applied_or_unknown when the file name that comes back is not the reviewed name", async () => {
    const fixture = await harness({ readbackFileName: "Week 2 handout.txt" });
    const planDigest = await planDigestOf(fixture);
    const result = await fixture.call("blackboard_apply_reviewed_content_attachment", applyArguments(planDigest));
    expect(structured(result)).toMatchObject({
      ok: false,
      resultState: "applied_or_unknown",
      problem: { code: "blackboard_content_mismatch", message: "Blackboard returned a different file name for the file it attached." },
    });
    expect(JSON.stringify(result)).not.toContain(fileBase64);
  });

  it("reports applied_or_unknown when the size that comes back is not the reviewed size", async () => {
    const fixture = await harness({ readbackSize: 1 });
    const planDigest = await planDigestOf(fixture);
    const result = structured(await fixture.call("blackboard_apply_reviewed_content_attachment", applyArguments(planDigest)));
    expect(result).toMatchObject({
      ok: false,
      resultState: "applied_or_unknown",
      problem: { code: "blackboard_content_mismatch", message: "Blackboard reported a different size for the file it attached." },
    });
  });

  it("keeps the course unchanged when the upload itself fails, and says so", async () => {
    const fixture = await harness({ uploadStatus: 500 });
    const planDigest = await planDigestOf(fixture);
    const result = structured(await fixture.call("blackboard_apply_reviewed_content_attachment", applyArguments(planDigest)));
    expect(result).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_request_failed", status: 500 } });
    expect(String((result.problem as JsonObject).message)).toContain("Morrow attached nothing to this Blackboard item.");
    expect(fixture.posts()).toEqual([`POST ${uploadsPath}`]);
  });

  it("attaches nothing when Blackboard does not name the file it staged", async () => {
    const fixture = await harness({ uploadWithoutId: true });
    const planDigest = await planDigestOf(fixture);
    const result = structured(await fixture.call("blackboard_apply_reviewed_content_attachment", applyArguments(planDigest)));
    expect(result).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_response_invalid" } });
    expect(fixture.posts()).toEqual([`POST ${uploadsPath}`]);
  });

  it("reports applied_or_unknown when Blackboard does not name the file it attached", async () => {
    const fixture = await harness({ attachWithoutId: true });
    const planDigest = await planDigestOf(fixture);
    const result = structured(await fixture.call("blackboard_apply_reviewed_content_attachment", applyArguments(planDigest)));
    expect(result).toMatchObject({
      ok: false,
      resultState: "applied_or_unknown",
      problem: { code: "blackboard_content_mismatch", message: "Blackboard did not name the file it attached, so Morrow could not read it back." },
    });
  });

  it("refuses a folder, the Ultra document wrapper, and a second file of one name", async () => {
    const folder = await harness();
    expect(structured(await folder.call("blackboard_plan_content_attachment", { content_id: folderId, ...manifest })))
      .toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_operation_unavailable" } });
    expect(folder.posts()).toEqual([]);
    await close?.();
    close = undefined;

    const wrapper = await harness();
    const refusedWrapper = structured(await wrapper.call("blackboard_plan_content_attachment", { content_id: wrapperId, ...manifest }));
    expect(refusedWrapper).toMatchObject({ ok: false, problem: { code: "blackboard_operation_unavailable" } });
    expect(String((refusedWrapper.problem as JsonObject).message)).toContain("Ultra document wrapper");
    await close?.();
    close = undefined;

    const duplicate = await harness({ duplicateName: true });
    const refusedDuplicate = structured(await duplicate.call("blackboard_plan_content_attachment", { content_id: documentId, ...manifest }));
    expect(refusedDuplicate).toMatchObject({ ok: false, problem: { code: "blackboard_operation_unavailable" } });
    expect(String((refusedDuplicate.problem as JsonObject).message)).toContain("already has a file with this name");
    expect(duplicate.posts()).toEqual([]);
  });

  it("refuses a dispatch whose item gained a file after review, and stages nothing", async () => {
    const fixture = await harness({ attachBetweenReads: true });
    const planDigest = await planDigestOf(fixture);
    const changed = structured(await fixture.call("blackboard_apply_reviewed_content_attachment", applyArguments(planDigest)));
    expect(changed).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_content_mismatch", message: "This Blackboard item changed after review. Morrow staged nothing and attached nothing." },
    });
    expect(fixture.posts()).toEqual([]);
  });

  it("refuses a dispatch addressed at another item, and stages nothing", async () => {
    const fixture = await harness();
    const planDigest = await planDigestOf(fixture);
    const elsewhere = structured(await fixture.call("blackboard_apply_reviewed_content_attachment", applyArguments(planDigest, {
      content_id: folderId,
    })));
    expect(elsewhere).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_operation_unavailable" } });
    expect(fixture.posts()).toEqual([]);
  });

  it("returns no file bytes when it refuses a malformed dispatch", async () => {
    const fixture = await harness();
    let serialized: string;
    try {
      // No expected_plan_digest: the request is refused against the schema,
      // with the reviewed bytes in the arguments it was refused for.
      serialized = JSON.stringify(await fixture.call("blackboard_apply_reviewed_content_attachment", {
        content_id: documentId, ...manifest, privateAttachment, _morrow: { outer_grant: grantArguments(effectGrant("d".repeat(64))) },
      }));
    } catch (error) {
      const detail = error as { message?: string; data?: unknown; code?: unknown };
      serialized = JSON.stringify({ message: detail.message, data: detail.data, code: detail.code, text: String(error) });
    }
    expect(serialized).not.toContain(fileBase64);
    expect(serialized).not.toContain("fixture bytes");
    expect(fixture.requests()).toEqual([]);
  });

  it("compares one attached file by name and size without reading the course roster", async () => {
    const fixture = await harness();
    const verified = structured(await fixture.call("blackboard_verify_content_attachment", {
      content_id: documentId, ...manifest, filename: "Syllabus notes.txt", size_bytes: 24,
    }));
    expect(verified).toMatchObject({
      schema: "morrow.blackboard.content-attachment.comparator.v1",
      ok: true,
      courseId,
      contentId: documentId,
      verified: true,
      readback: "metadata_only",
    });
    expect(verified).not.toHaveProperty("diagnostics");
    expect(fixture.requests()).not.toContain(`GET ${rosterPath}`);

    const absent = structured(await fixture.call("blackboard_verify_content_attachment", { content_id: documentId, ...manifest }));
    expect(absent).toMatchObject({ ok: true, verified: false });
  });
});
