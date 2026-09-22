import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { BridgeCommand } from "@morrow/bridge-protocol";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { parseGatewayConfig } from "../src/config.js";
import { GatewayRuntime } from "../src/runtime.js";
import { createMorrowServer } from "../src/server.js";
import { LoopbackApprovalServer } from "../src/approval-server.js";
import { bridgeCatalogDigestForTests } from "./fixtures/bridge-catalog-digest.js";
import { connectBridgeTestClient, type BridgeTestClient } from "./fixtures/bridge-client.js";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test port unavailable");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

function operationId(result: JsonObject): string {
  const id = isJsonObject(result.structuredContent) ? result.structuredContent.operationId : undefined;
  if (typeof id !== "string") throw new Error(`file operation unavailable: ${JSON.stringify(result)}`);
  return id;
}

function imscpPackageBytes(): Buffer {
  const filename = Buffer.from("imsmanifest.xml", "utf8");
  const content = Buffer.from("<manifest/>", "utf8");
  const local = Buffer.alloc(30 + filename.length + content.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(filename.length, 26);
  filename.copy(local, 30);
  content.copy(local, 30 + filename.length);
  const central = Buffer.alloc(46 + filename.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(filename.length, 28);
  filename.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

describe("reviewed Moodle file dispatch", () => {
  it("freezes local bytes outside the journal, sends only once after review, and refuses changed sessions and lost stages", async () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-resource-dispatch-"));
    const workspaceRoot = realpathSync(directory);
    const root = resolve("../..");
    const port = await availablePort();
    const canvasPath = resolve(root, "artifacts/canvas-api/canvas-api-catalog.json");
    const browserDigest = bridgeCatalogDigestForTests(root);
    const token = "synthetic-resource-token-".repeat(3);
    const extensionId = "a".repeat(32);
    const sourceBindingId = "moodle:resource-test";
    const config = parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      profile: "private-full",
      toolSurface: "full",
      upstreams: [{
        id: "browser-session", label: "Morrow browser connector", kind: "mcp-stdio",
        command: process.execPath, args: [resolve(root, "packages/canvas-connector-mcp/dist/index.js")], cwd: root,
        env: {
          MORROW_CANVAS_CATALOG_PATH: canvasPath,
          MORROW_CANVAS_CONNECTOR_STATE: join(directory, "connector.json"),
          MORROW_CANVAS_CONNECTOR_PORT: String(port),
          MORROW_CANVAS_CONNECTOR_TOKEN: token,
          MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: extensionId,
        },
        sourceDisposition: "adapted_owned", outputPrivacy: {},
        outputPrivacyDefault: {
          allowedFields: [], fieldPolicy: "scrub-sensitive", dataClass: "course", maxRecords: 10_000,
          maxBytes: 2_000_000, freeText: "allow", learnerTokens: true, artifactInspection: "deny", aiClientAdmission: "allow",
        },
      }],
      filters: { excludePrefixes: [], excludeNames: [] },
      operationJournal: { path: join(directory, "gateway.sqlite3") },
      privacy: { canvasOrigin: "browser-session", account: "local", principal: "local", learnerVaultPath: join(directory, "vault.json") },
      maxCatalogTools: 2_000,
    });
    let runtime = await GatewayRuntime.connect(config);
    let bridge: BridgeTestClient | undefined;
    let server: ReturnType<typeof serveStdio> | undefined;
    let client: Client | undefined;
    let approval: LoopbackApprovalServer | undefined;
    let sessionGeneration = 1;
    const writes: BridgeCommand[] = [];
    const formDigest = "e".repeat(64);
    const binding = () => ({
      sourceBindingId, provider: "moodle" as const, origin: "https://moodle.example.edu",
      siteUrl: "https://moodle.example.edu/", courseId: "2", courseName: "Biology",
      principalFingerprint: "d".repeat(64), sessionGeneration, catalogDigest: browserDigest,
      editPolicyRevision: 0, editOptionsAvailable: true, runtimeVerified: true,
    });
    const connectBrowser = async () => {
      const current = await connectBridgeTestClient({
        port, token, extensionId, catalogDigest: browserDigest, bindings: [binding()],
      });
      bridge = current;
      current.onCommand((message) => {
        if (message.kind === "edit_policy_options_get") {
          current.respond(message, {
            schema: "morrow.bridge.edit-options.v1", sourceBindingId, provider: "moodle",
            catalogDigest: browserDigest, policyRevision: 0, runtimeVerified: true,
            options: [{
              id: "content", group: "Moodle content", label: "Edit saved content",
              description: "Update saved content fields.", availability: "edit",
            }, {
              id: "file", group: "Moodle content", label: "Add a course file",
              description: "Review the exact file before adding it.", availability: "review", reviewReason: "This action requires a file review.",
            }],
          });
          return;
        }
        if (message.kind === "invoke_write") writes.push(message);
        current.respond(message, {
          schema: "morrow.moodle-browser-result.v1", ok: true, sent: true, status: 200,
          targets: [{ field: "course_id", label: "Course", name: "Biology" }, { field: "section_id", label: "Section", name: "Week 1" }],
          data: message.toolName === "moodle_get_contents"
            ? { course_id: 2, content: "Jane Moodle private note" }
            : message.toolName === "moodle_get_resource_files"
              ? { course_id: 2, module_id: 31, files: [{ filename: "old.pdf", size_bytes: 4 }] }
              : message.toolName === "moodle_get_folder_files"
                ? { course_id: 2, module_id: 32, files: [], paths: ["/"] }
              : message.toolName === "moodle_get_scorm"
                ? { course_id: 2, module_id: 33, name: "SCORM" }
                : message.toolName === "moodle_get_h5pactivity"
                  ? { course_id: 2, module_id: 34, name: "H5P activity", visible: false }
                  : { course_id: 2, section_id: 7, name: "Resource", visible: false }, snapshot_digest: formDigest,
          ...(message.kind === "invoke_write" ? {
            verification: { schema: "morrow.browser-verification.v1", status: "verified", strategy: "saved_resource_file_bytes" },
          } : {}),
        });
      });
    };
    const input = { source_binding_id: sourceBindingId, course_id: 2, section_id: 7, name: "Study guide", file_path: "guide.txt" };
    const bytes = Buffer.from("exact-private-course-file-content-4719");
    const base64 = bytes.toString("base64");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const closeBrowser = async () => {
      await bridge?.close();
    };
    try {
      await connectBrowser();
      approval = new LoopbackApprovalServer({
        operationGet: (id) => runtime.operationGet(id),
        operationList: (limit) => runtime.operationList(limit),
        operationReviewContext: (id, cache) => runtime.operationReviewContext(id, cache),
        approveOperation: (id) => runtime.approveOperation(id),
        runApprovedOperation: (id) => runtime.dispatchOperation(id),
        cancelOperation: (id) => runtime.cancelOperation(id),
        setApprovalBaseUrl: (baseUrl) => runtime.setApprovalBaseUrl(baseUrl),
      });
      await approval.start();
      const [a, b] = InMemoryTransport.createLinkedPair();
      server = serveStdio(() => createMorrowServer(runtime, undefined, { workspaceRoot }), { transport: b });
      client = new Client({ name: "morrow-moodle-resource-boundary", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
      await client.connect(a);
      expect(runtime.searchCatalog({ query: "participant roster" }).tools.map((tool) => tool.publicName))
        .not.toContain("moodle_get_course_participant_roster");
      expect(runtime.capabilityGet("moodle_get_course_participant_roster")).toMatchObject({ code: "capability_not_found" });
      expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("moodle_get_course_participant_roster");
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("morrow_plan_moodle_folder_file");
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("morrow_plan_moodle_imscp_package");
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("morrow_plan_moodle_scorm_package");
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("morrow_plan_moodle_resource_file_replacement");
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("morrow_plan_moodle_folder_files");
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("morrow_plan_moodle_scorm_package_replacement");
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("morrow_plan_moodle_h5p_package");
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("morrow_plan_moodle_h5p_package_replacement");
      const hiddenRoster = await client.callTool({
        name: "morrow_capability_read",
        arguments: { name: "moodle_get_course_participant_roster", arguments: { course_id: 2 } },
      });
      expect(hiddenRoster.structuredContent).toMatchObject({ code: "capability_not_found" });

      const editOptions = await client.callTool({
        name: "morrow_browser_edit_options",
        arguments: { source_binding_id: sourceBindingId },
      });
      const editOptionsText = JSON.stringify(editOptions);
      expect(editOptions.isError, editOptionsText).not.toBe(true);
      expect(editOptionsText).not.toContain("Biology");
      expect(editOptionsText).not.toContain("Jane Moodle private note");
      expect(editOptions.structuredContent).toMatchObject({
        schema: "morrow.result.v1", tool: "morrow_browser_edit_options",
        data: {
          schema: "morrow.bridge.edit-options.v1", sourceBindingId, provider: "moodle",
          catalogDigest: browserDigest, policyRevision: 0, runtimeVerified: true,
          options: [
            { id: "content", availability: "edit", description: "Update saved content fields." },
            { id: "file", availability: "review", description: "Review the exact file before adding it." },
          ],
        },
      });

      const editOptionsCapability = await client.callTool({
        name: "morrow_capability_read",
        arguments: { name: "morrow_browser_edit_options", arguments: { source_binding_id: sourceBindingId } },
      });
      const editOptionsCapabilityText = JSON.stringify(editOptionsCapability);
      expect(editOptionsCapability.isError, editOptionsCapabilityText).not.toBe(true);
      expect(editOptionsCapabilityText).not.toContain("Biology");
      expect(editOptionsCapabilityText).not.toContain("Jane Moodle private note");
      expect(editOptionsCapability.structuredContent).toMatchObject({
        schema: "morrow.result.v1", tool: "morrow_browser_edit_options",
        data: { schema: "morrow.bridge.edit-options.v1", sourceBindingId, provider: "moodle" },
      });
      expect(await runtime.prepareBrowserEditAccess("edit", [{ sourceBindingId, enabledCategories: ["content"] }])).toMatchObject({
        mode: "edit", selections: [{ sourceBindingId, expectedPolicyRevision: 0, enabledCategories: [{ id: "content" }] }],
      });
      await expect(runtime.prepareBrowserEditAccess("edit", [{ sourceBindingId, enabledCategories: ["file"] }]))
        .rejects.toThrow("cannot receive Edit access");

      writeFileSync(join(directory, input.file_path), bytes);
      const planned = await client.callTool({ name: "morrow_plan_moodle_resource_file", arguments: input });
      const plannedText = JSON.stringify(planned);
      expect(planned.isError, plannedText).not.toBe(true);
      expect(plannedText).not.toContain(base64);
      expect(plannedText).not.toContain(bytes.toString());
      expect(plannedText).not.toContain(input.file_path);
      const id = operationId(planned as unknown as JsonObject);

      const compactRead = await client.callTool({
        name: "morrow_capability_read",
        arguments: { name: "moodle_get_contents", arguments: { course_id: 2, _morrow: { source_binding_id: sourceBindingId } } },
      });
      const compactText = JSON.stringify(compactRead);
      expect(compactRead.isError, compactText).toBe(true);
      expect(compactText).toContain("learner_roster_source_unavailable");
      expect(compactText).not.toContain("Jane Moodle private note");

      const audit = await client.callTool({
        name: "morrow_audit_course",
        arguments: { provider: "moodle", source_binding_id: sourceBindingId, course_id: 2, target: { kind: "page", module_id: 7 } },
      });
      const auditText = JSON.stringify(audit);
      expect(audit.isError, auditText).toBe(true);
      expect(auditText).toContain("learner_roster_source_unavailable");
      expect(auditText).not.toContain("Jane Moodle private note");
      const frozen = runtime.operationGet(id);
      expect(frozen).toMatchObject({ state: "awaiting_approval", plan: { authorization: { kind: "review" }, arguments: {
        course_id: 2, section_id: 7, filename: "guide.txt", size_bytes: bytes.length, sha256: digest, expected_digest: formDigest,
      } } });
      expect(JSON.stringify(frozen)).not.toContain(base64);
      expect(JSON.stringify(frozen)).not.toContain(bytes.toString());
      expect(JSON.stringify(frozen)).not.toContain("file_path");
      expect((await runtime.dispatchOperation(id)).isError).toBe(true);
      expect(writes).toHaveLength(0);
      writeFileSync(join(directory, input.file_path), "changed after review preparation");
      const reviewUrl = runtime.approvalUrl(id)!;
      const review = await fetch(reviewUrl);
      const reviewHtml = await review.text();
      expect(review.status).toBe(200);
      expect(reviewHtml).toContain("Biology");
      expect(reviewHtml).toContain("Week 1");
      expect(reviewHtml).toContain("guide.txt");
      expect(reviewHtml).toContain(digest);
      expect(reviewHtml).toContain("Visible to learners");
      expect(reviewHtml).not.toContain(base64);
      expect(reviewHtml).not.toContain(bytes.toString());
      const nonce = /name="nonce" value="([^"]+)"/.exec(reviewHtml)?.[1];
      const cookie = review.headers.get("set-cookie")?.split(";", 1)[0];
      expect(nonce).toBeTruthy();
      expect(cookie).toBeTruthy();
      const confirmed = await fetch(`${reviewUrl}/approve`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie!, origin: new URL(reviewUrl).origin, referer: reviewUrl },
        body: new URLSearchParams({ nonce: nonce! }),
      });
      expect(confirmed.status).toBe(200);
      await expect.poll(() => runtime.operationGet(id).state).toBe("verified");
      expect(runtime.operationGet(id)).toMatchObject({ state: "verified" });
      expect(writes).toHaveLength(1);
      expect(writes[0]?.privateAttachment).toMatchObject({ bytes_base64: base64, manifest: { filename: "guide.txt", size_bytes: bytes.length, sha256: digest } });
      expect(JSON.stringify(writes[0]?.arguments)).not.toContain(base64);
      expect(writes[0]?.outerGrant?.authorization).toEqual({ kind: "review" });
      await runtime.dispatchOperation(id);
      expect(writes).toHaveLength(1);

      const folderInput = { ...input, name: "Folder study guide", file_path: "folder-guide.txt" };
      writeFileSync(join(directory, folderInput.file_path), bytes);
      const plannedFolder = await client.callTool({ name: "morrow_plan_moodle_folder_file", arguments: folderInput });
      expect(plannedFolder.isError, JSON.stringify(plannedFolder)).not.toBe(true);
      const folderId = operationId(plannedFolder as unknown as JsonObject);
      expect(runtime.operationGet(folderId)).toMatchObject({ state: "awaiting_approval", publicToolName: "moodle_create_folder_file", plan: { arguments: {
        course_id: 2, section_id: 7, filename: "folder-guide.txt", size_bytes: bytes.length, sha256: digest, expected_digest: formDigest,
      } } });
      runtime.approveOperation(folderId);
      const folderDispatch = await runtime.dispatchOperation(folderId);
      expect(folderDispatch.isError, JSON.stringify(folderDispatch)).not.toBe(true);
      expect(runtime.operationGet(folderId)).toMatchObject({ state: "verified" });
      expect(writes).toHaveLength(2);
      expect(writes[1]?.toolName).toBe("moodle_create_folder_file");
      expect(writes[1]?.privateAttachment).toMatchObject({ bytes_base64: base64, manifest: { filename: "folder-guide.txt", size_bytes: bytes.length, sha256: digest } });

      const imscpBytes = imscpPackageBytes();
      const imscpBase64 = imscpBytes.toString("base64");
      const imscpDigest = createHash("sha256").update(imscpBytes).digest("hex");
      const imscpInput = { ...input, name: "Week 1 package", file_path: "package.zip" };
      writeFileSync(join(directory, imscpInput.file_path), imscpBytes);
      const plannedImscp = await client.callTool({ name: "morrow_plan_moodle_imscp_package", arguments: imscpInput });
      expect(plannedImscp.isError, JSON.stringify(plannedImscp)).not.toBe(true);
      const imscpId = operationId(plannedImscp as unknown as JsonObject);
      expect(runtime.operationGet(imscpId)).toMatchObject({ state: "awaiting_approval", publicToolName: "moodle_create_imscp_package", plan: { arguments: {
        course_id: 2, section_id: 7, filename: "package.zip", size_bytes: imscpBytes.length, sha256: imscpDigest, expected_digest: formDigest,
      } } });
      runtime.approveOperation(imscpId);
      const imscpDispatch = await runtime.dispatchOperation(imscpId);
      expect(imscpDispatch.isError, JSON.stringify(imscpDispatch)).not.toBe(true);
      expect(runtime.operationGet(imscpId)).toMatchObject({ state: "verified" });
      expect(writes).toHaveLength(3);
      expect(writes[2]?.toolName).toBe("moodle_create_imscp_package");
      expect(writes[2]?.privateAttachment).toMatchObject({ bytes_base64: imscpBase64, manifest: { filename: "package.zip", size_bytes: imscpBytes.length, sha256: imscpDigest } });

      const replacementBytes = Buffer.from("reviewed-replacement-file");
      const replacementDigest = createHash("sha256").update(replacementBytes).digest("hex");
      writeFileSync(join(directory, "replacement.pdf"), replacementBytes);
      const replacementPlan = await client.callTool({ name: "morrow_plan_moodle_resource_file_replacement", arguments: {
        source_binding_id: sourceBindingId, course_id: 2, module_id: 31, file_path: "replacement.pdf",
      } });
      expect(replacementPlan.isError, JSON.stringify(replacementPlan)).not.toBe(true);
      const replacementId = operationId(replacementPlan as unknown as JsonObject);
      expect(runtime.operationGet(replacementId)).toMatchObject({ publicToolName: "moodle_replace_resource_file", plan: { arguments: {
        course_id: 2, module_id: 31, filename: "replacement.pdf", size_bytes: replacementBytes.length, sha256: replacementDigest, expected_digest: formDigest,
      } } });
      runtime.approveOperation(replacementId);
      expect((await runtime.dispatchOperation(replacementId)).isError).not.toBe(true);
      expect(writes[3]?.toolName).toBe("moodle_replace_resource_file");
      expect(writes[3]?.privateAttachment).toMatchObject({ bytes_base64: replacementBytes.toString("base64"), manifest: { filename: "replacement.pdf", size_bytes: replacementBytes.length, sha256: replacementDigest } });

      const folderBytes = [Buffer.from("first-folder-file"), Buffer.from("second-folder-file")];
      const folderFiles = ["first.txt", "second.txt"];
      for (const [index, filename] of folderFiles.entries()) writeFileSync(join(directory, filename), folderBytes[index]!);
      const folderFilesPlan = await client.callTool({ name: "morrow_plan_moodle_folder_files", arguments: {
        source_binding_id: sourceBindingId, course_id: 2, module_id: 32, folder_path: "/", file_paths: folderFiles,
      } });
      expect(folderFilesPlan.isError, JSON.stringify(folderFilesPlan)).not.toBe(true);
      const folderFilesId = operationId(folderFilesPlan as unknown as JsonObject);
      runtime.approveOperation(folderFilesId);
      expect((await runtime.dispatchOperation(folderFilesId)).isError).not.toBe(true);
      expect(writes[4]?.toolName).toBe("moodle_add_folder_files");
      expect(writes[4]?.privateAttachment).toBeUndefined();
      expect(writes[4]?.privateAttachments).toHaveLength(2);
      expect(writes[4]?.privateAttachments?.map((entry) => entry.manifest)).toEqual(folderBytes.map((file, index) => ({
        filename: folderFiles[index], size_bytes: file.length, sha256: createHash("sha256").update(file).digest("hex"),
      })));

      const scormReplacementBytes = Buffer.from("synthetic-replacement.zip");
      const scormReplacementDigest = createHash("sha256").update(scormReplacementBytes).digest("hex");
      writeFileSync(join(directory, "replacement.zip"), scormReplacementBytes);
      const scormReplacementPlan = await client.callTool({ name: "morrow_plan_moodle_scorm_package_replacement", arguments: {
        source_binding_id: sourceBindingId, course_id: 2, module_id: 33, file_path: "replacement.zip",
      } });
      expect(scormReplacementPlan.isError, JSON.stringify(scormReplacementPlan)).not.toBe(true);
      const scormReplacementId = operationId(scormReplacementPlan as unknown as JsonObject);
      runtime.approveOperation(scormReplacementId);
      expect((await runtime.dispatchOperation(scormReplacementId)).isError).not.toBe(true);
      expect(writes[5]?.toolName).toBe("moodle_replace_scorm_package");
      expect(writes[5]?.privateAttachment).toMatchObject({ bytes_base64: scormReplacementBytes.toString("base64"), manifest: { filename: "replacement.zip", size_bytes: scormReplacementBytes.length, sha256: scormReplacementDigest } });

      const invalidH5p = await client.callTool({ name: "morrow_plan_moodle_h5p_package", arguments: input });
      expect(invalidH5p.isError).toBe(true);
      expect(writes).toHaveLength(6);
      const h5pBytes = Buffer.from("synthetic-private-h5p-transport-fixture");
      const h5pDigest = createHash("sha256").update(h5pBytes).digest("hex");
      writeFileSync(join(directory, "activity.h5p"), h5pBytes);
      const h5pPlan = await client.callTool({ name: "morrow_plan_moodle_h5p_package", arguments: {
        ...input, name: "H5P activity", file_path: "activity.h5p",
      } });
      expect(h5pPlan.isError, JSON.stringify(h5pPlan)).not.toBe(true);
      const h5pId = operationId(h5pPlan as unknown as JsonObject);
      expect(writes).toHaveLength(6);
      expect(runtime.operationGet(h5pId)).toMatchObject({ state: "awaiting_approval", publicToolName: "moodle_create_h5pactivity" });
      runtime.approveOperation(h5pId);
      expect((await runtime.dispatchOperation(h5pId)).isError).not.toBe(true);
      expect(runtime.operationGet(h5pId)).toMatchObject({ state: "verified" });
      expect(writes[6]?.toolName).toBe("moodle_create_h5pactivity");
      expect(writes[6]?.privateAttachment).toMatchObject({ bytes_base64: h5pBytes.toString("base64"), manifest: { filename: "activity.h5p", size_bytes: h5pBytes.length, sha256: h5pDigest } });
      expect((await runtime.dispatchOperation(h5pId)).isError).toBe(true);
      expect(writes).toHaveLength(7);

      const invalidH5pReplacement = await client.callTool({ name: "morrow_plan_moodle_h5p_package_replacement", arguments: {
        source_binding_id: sourceBindingId, course_id: 2, module_id: 34, file_path: "replacement.zip",
      } });
      expect(invalidH5pReplacement.isError).toBe(true);
      expect(writes).toHaveLength(7);
      const h5pReplacementBytes = Buffer.from("synthetic-private-h5p-replacement-fixture");
      const h5pReplacementDigest = createHash("sha256").update(h5pReplacementBytes).digest("hex");
      writeFileSync(join(directory, "replacement.h5p"), h5pReplacementBytes);
      const h5pReplacementPlan = await client.callTool({ name: "morrow_plan_moodle_h5p_package_replacement", arguments: {
        source_binding_id: sourceBindingId, course_id: 2, module_id: 34, file_path: "replacement.h5p",
      } });
      expect(h5pReplacementPlan.isError, JSON.stringify(h5pReplacementPlan)).not.toBe(true);
      const h5pReplacementId = operationId(h5pReplacementPlan as unknown as JsonObject);
      expect(runtime.operationGet(h5pReplacementId)).toMatchObject({
        state: "awaiting_approval", publicToolName: "moodle_replace_h5pactivity_package", plan: { arguments: {
          course_id: 2, module_id: 34, filename: "replacement.h5p", size_bytes: h5pReplacementBytes.length,
          sha256: h5pReplacementDigest, expected_digest: formDigest,
        } },
      });
      runtime.approveOperation(h5pReplacementId);
      const h5pReplacementDispatch = await runtime.dispatchOperation(h5pReplacementId);
      expect(h5pReplacementDispatch.isError, JSON.stringify(h5pReplacementDispatch)).not.toBe(true);
      expect(runtime.operationGet(h5pReplacementId)).toMatchObject({ state: "verified" });
      expect(writes[7]?.toolName).toBe("moodle_replace_h5pactivity_package");
      expect(writes[7]?.privateAttachment).toMatchObject({
        bytes_base64: h5pReplacementBytes.toString("base64"),
        manifest: { filename: "replacement.h5p", size_bytes: h5pReplacementBytes.length, sha256: h5pReplacementDigest },
      });
      expect((await runtime.dispatchOperation(h5pReplacementId)).isError).toBe(true);
      expect(writes).toHaveLength(8);

      const generic = await runtime.call("moodle_create_resource_file", {
        course_id: 2, section_id: 7, name: input.name, filename: "guide.txt", size_bytes: bytes.length, sha256: digest,
        expected_digest: formDigest, _morrow: { source_binding_id: sourceBindingId },
      });
      expect(generic.isError).toBe(true);
      const privateInput = await runtime.callSourceOwned("moodle_get_resource_file_creation_form", { nested: { privateAttachment: { bytes_base64: base64 } } });
      expect(privateInput.isError).toBe(true);

      const changed = operationId(await runtime.planMoodleResourceFile(input, { workspaceRoot }));
      runtime.approveOperation(changed);
      sessionGeneration = 2;
      bridge!.updateBindings([binding()]);
      await expect.poll(async () => {
        const response = await runtime.callSourceOwned("morrow_browser_bindings", {});
        return JSON.stringify(response).includes('"sessionGeneration":2');
      }).toBe(true);
      expect((await runtime.dispatchOperation(changed)).isError).toBe(true);
      expect(writes).toHaveLength(8);
      expect(runtime.operationGet(changed)).toMatchObject({ state: "cancelled", dispatchAttempt: 0 });

      const lost = operationId(await runtime.planMoodleResourceFile(input, { workspaceRoot }));
      runtime.approveOperation(lost);
      await closeBrowser();
      await approval.close();
      approval = undefined;
      await runtime.close();
      runtime = await GatewayRuntime.connect(config);
      await connectBrowser();
      expect((await runtime.dispatchOperation(lost)).isError).toBe(true);
      expect(runtime.operationGet(lost)).toMatchObject({ state: "cancelled", dispatchAttempt: 0 });
      expect(writes).toHaveLength(8);
    } finally {
      await approval?.close();
      await client?.close();
      await server?.close();
      await closeBrowser();
      await runtime.close();
      const database = readFileSync(join(directory, "gateway.sqlite3"));
      expect(database.includes(bytes)).toBe(false);
      expect(database.includes(Buffer.from(base64))).toBe(false);
      expect(database.includes(imscpPackageBytes())).toBe(false);
      expect(database.includes(Buffer.from(imscpPackageBytes().toString("base64")))).toBe(false);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
