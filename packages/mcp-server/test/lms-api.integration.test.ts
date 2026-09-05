import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import { parseGatewayConfig } from "../src/config.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";
import { LmsApiRuntime, parseLmsConnections } from "../src/lms-api.js";
import { MOODLE_API_OPERATIONS } from "../src/moodle-api.js";

const fixture = fileURLToPath(new URL("./fixtures/lms-api-upstream.mjs", import.meta.url));
function object(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error("Expected object");
  return value;
}

function readData(runtime: MorrowRuntime, response: JsonObject): JsonObject {
  const data = object(object(response.structuredContent).data);
  if (data.schema !== "morrow.result-artifact.v1") return data;
  expect(data.totalCharacters).toBeGreaterThan(64_000);
  let text = "";
  let offset: number | null = 0;
  do {
    const page = runtime.gateway.resultPage(String(data.handle), offset);
    text += String(page.text);
    offset = page.nextOffset === null ? null : Number(page.nextOffset);
  } while (offset !== null);
  return object(object(JSON.parse(text)).structuredContent);
}

describe("Moodle and Blackboard controlled changes", () => {
  it("reads both platforms, approves each once, and shows verified named results through the gateway", async () => {
    const runtime = await MorrowRuntime.connect(parseGatewayConfig({
      schema: "morrow.upstreams.v1", profile: "private-full",
      upstreams: [{ id: "lms-api", label: "Learning platforms", kind: "mcp-stdio", command: process.execPath, args: [fixture],
        sourceDisposition: "direct_owned", outputPrivacyDefault: { fieldPolicy: "scrub-sensitive", dataClass: "course", maxRecords: 1000, maxBytes: 500000, freeText: "allow", learnerTokens: true } }],
      operationJournal: { path: ":memory:" },
    }), { statePath: ":memory:" });
    async function approve(name: string, readName: string, args: JsonObject, change: JsonObject, platform: string) {
      const read = readData(runtime, await runtime.gateway.call(readName, args));
      expect(read.ok).toBe(true);
      const planned = object((await runtime.gateway.call(name, { ...args, ...change, expected_digest: read.snapshot_digest, expected_connection: read.connection_digest })).structuredContent);
      expect(planned.effectState).toBe("awaiting_approval");
      const url = String(object(planned.receipts).approvalUrl);
      const page = await fetch(url);
      const html = await page.text();
      expect(html).toContain(`Biology · ${platform}`);
      expect(html).toContain(`checks them in ${platform}`);
      expect(html).toContain("Current content and values");
      expect(html).not.toContain("<dt>Expected digest</dt>");
      const nonce = /name="nonce" value="([^"]+)"/.exec(html)?.[1];
      const cookie = page.headers.get("set-cookie")!.split(";", 1)[0]!;
      const approval = await fetch(`${url}/approve`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(url).origin, referer: url, cookie }, body: new URLSearchParams({ nonce: nonce! }) });
      expect(approval.status).toBe(200);
      const operationId = String(planned.operationId);
      for (let attempt = 0; attempt < 100 && runtime.gateway.operationGet(operationId).state !== "verified"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runtime.gateway.operationGet(operationId)).toMatchObject({ state: "verified", dispatchAttempt: 1 });
      expect((await runtime.gateway.dispatchOperation(operationId)).isError).toBe(true);
      const confirmed = await (await fetch(url)).text();
      expect(confirmed).toContain(`Morrow checked ${platform} and confirmed`);
      return readData(runtime, await runtime.gateway.call(readName, args)).data;
    }
    try {
      expect(runtime.gateway.capabilityGet("moodle_get_course").descriptor).toMatchObject({ provider: "moodle", route: { backend: "lms-api" } });
      const moodle = await approve("moodle_update_course_summary", "moodle_get_course", { connection_id: "moodle-test", course_id: 17 }, { summary: "<p>Start with the cell diagram.</p>" }, "Moodle");
      expect(moodle).toMatchObject({ summary: "<p>Start with the cell diagram.</p>", visible: 0, timemodified: 2 });
      const largeReplacement = '<!-- {"bbMLEditorVersion":1} --><div><h4>Cell structure</h4>' + "<p><strong>Ribosomes assemble proteins.</strong> Explain how structure relates to function.</p>".repeat(750) + "</div>";
      const blackboard = await approve("blackboard_update_content", "blackboard_get_content", { connection_id: "blackboard-test", course_id: "_12_1", content_id: "_34_1" }, { title: "Cell structure: Start here", body: largeReplacement }, "Blackboard");
      expect(blackboard).toMatchObject({ content: { title: "Cell structure: Start here", body: largeReplacement, availability: { available: "No" }, modified: "2" } });
    } finally { await runtime.close(); }
  }, 20000);

  it("refuses missing approval and a stale snapshot, and does not retry an uncertain write or expose credentials", async () => {
    const token = "synthetic-private-token";
    const connection = { id: "school", label: "School", provider: "moodle", baseUrl: "https://school.example/moodle", token };
    const connections = parseLmsConnections({ schema: "morrow.lms-connections.v1", connections: [connection] });
    let summary = "Before";
    let writes = 0;
    const runtime = new LmsApiRuntime(connections, MOODLE_API_OPERATIONS, async (url, options) => {
      expect(String(url)).toBe("https://school.example/moodle/webservice/rest/server.php");
      expect(String(url)).not.toContain(token);
      expect(options?.redirect).toBe("error");
      const form = options?.body as URLSearchParams;
      expect(form.get("moodlewssettingraw")).toBe("true");
      const fn = form.get("wsfunction");
      if (fn === "core_webservice_get_site_info") return Response.json({ userid: 9, siteurl: connection.baseUrl, functions: ["core_course_get_courses", "core_course_update_courses"].map((name) => ({ name })) });
      if (fn === "core_course_get_courses") return Response.json([{ id: 17, fullname: "Biology", summary, summaryformat: 1 }]);
      writes += 1;
      throw new Error(`Uncertain network result ${token}`);
    });
    const args = { connection_id: "school", course_id: 17 };
    const before = await runtime.call("moodle_get_course", args);
    const change = { ...args, summary: "After", expected_digest: before.snapshot_digest, expected_connection: before.connection_digest };
    expect(await runtime.call("moodle_update_course_summary", change)).toMatchObject({ ok: false, resultState: "not_sent", code: "approval_unavailable" });
    const _morrow = { operation_id: "operation:test", outer_grant: { dispatch_attempt: 1, plan_digest: "a".repeat(64), approval_grant_digest: "b".repeat(64), effect_receipt_id: "effect:test", gateway_process_id: "gateway:test" } };
    summary = "A newer instructor edit";
    expect(await runtime.call("moodle_update_course_summary", { ...change, _morrow })).toMatchObject({ ok: false, resultState: "not_sent", code: "changed_unavailable" });
    expect(writes).toBe(0);
    const latest = await runtime.call("moodle_get_course", args);
    const failed = await runtime.call("moodle_update_course_summary", { ...change, expected_digest: latest.snapshot_digest, _morrow });
    expect(failed).toMatchObject({ ok: false, resultState: "applied_or_unknown" });
    expect(writes).toBe(1);
    expect(JSON.stringify([runtime.connectionList(), before, failed])).not.toContain(token);

    const gateway = await MorrowRuntime.connect(parseGatewayConfig({
      schema: "morrow.upstreams.v1", profile: "private-full",
      upstreams: [{ id: "lms-api", label: "Learning platforms", kind: "mcp-stdio", command: process.execPath, args: [fixture],
        sourceDisposition: "direct_owned", outputPrivacyDefault: { fieldPolicy: "scrub-sensitive", dataClass: "course", maxRecords: 1000, maxBytes: 500000, freeText: "allow", learnerTokens: true } }],
      operationJournal: { path: ":memory:" },
    }), { statePath: ":memory:" });
    try {
      const read = readData(gateway, await gateway.gateway.call("moodle_get_course", { connection_id: "moodle-test", course_id: 17 }));
      const planned = object((await gateway.gateway.call("moodle_update_course_summary", {
        connection_id: "moodle-test", course_id: 17, summary: "NETWORK_FAILURE",
        expected_digest: read.snapshot_digest, expected_connection: read.connection_digest,
      })).structuredContent);
      const operationId = String(planned.operationId);
      gateway.gateway.approveOperation(operationId);
      const uncertain = await gateway.gateway.dispatchOperation(operationId);
      expect(uncertain).toMatchObject({
        content: [{ text: expect.stringContaining("Moodle may have received this change") }],
        structuredContent: { effectState: "applied_or_unknown" },
      });
      expect(gateway.gateway.operationGet(operationId)).toMatchObject({ state: "applied_or_unknown", dispatchAttempt: 1 });
      expect((await gateway.gateway.dispatchOperation(operationId)).isError).toBe(true);
    } finally { await gateway.close(); }
  });
});
