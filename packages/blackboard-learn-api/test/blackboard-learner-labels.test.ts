import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearnerVault } from "@morrow/gateway-core";
import { describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { deriveBlackboardSourceBindingId } from "../src/binding.js";
import { BLACKBOARD_TOOL_DEFINITIONS } from "../src/operations/index.js";
import { BlackboardLearnRuntime } from "../src/runtime.js";
import { createBlackboardLearnMcpServer } from "../src/server.js";

const baseUrl = "https://blackboard.example.invalid";
const principalId = "_11_1";
const courses = ["_22_1", "_23_1"];
const tenant = {
  id: "fixture", baseUrl, principalId, applicationKey: "test", clientSecret: "test",
  courseBindings: courses.map((courseId) => ({ courseId, sourceBindingId: deriveBlackboardSourceBindingId(baseUrl, principalId, courseId) })),
};

describe("Blackboard readable learner labels", () => {
  it("requires readable labels in every registered learner action schema", () => {
    let checked = 0;
    for (const tool of BLACKBOARD_TOOL_DEFINITIONS) {
      const schema = z.toJSONSchema(tool.inputSchema) as { properties?: Record<string, { pattern?: string }> };
      const learner = schema.properties?.learner_reference;
      if (!learner) continue;
      checked += 1;
      const pattern = new RegExp(learner.pattern!);
      expect(pattern.test("Student A1"), tool.name).toBe(true);
      for (const reference of ["Student A0", "Student A01", "Student A1 or Student A2", "_44_1", "learner_2f1a5b3c-9d4e-4f6a-8b7c-1d2e3f4a5b6c"]) {
        expect(pattern.test(reference), `${tool.name}: ${reference}`).toBe(false);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(8);
  });

  it("resolves a repeated label only in its exact Blackboard course scope", () => {
    const vault = new LearnerVault(":memory:");
    const runtime = new BlackboardLearnRuntime([tenant], { learnerVault: vault });
    const scope = (course: string) => ({ canvasOrigin: baseUrl, account: tenant.id, course, principal: principalId, profile: "blackboard-learn-api" });
    const request = (courseId: string, reference: string) => ({ tenantId: tenant.id, sourceBindingId: deriveBlackboardSourceBindingId(baseUrl, principalId, courseId), courseId, reference });
    const label = vault.tokenize(scope(courses[0]!), { id: "_44_1", name: "Jane Doe" });
    expect(label).toBe("Student A1");
    expect(runtime.learnerAccountId(request(courses[0]!, label))).toBe("_44_1");
    expect(() => runtime.learnerAccountId(request(courses[1]!, label))).toThrow("does not hold");
    expect(vault.tokenize(scope(courses[1]!), { id: "_45_1", name: "John Roe" })).toBe(label);
    expect(runtime.learnerAccountId(request(courses[1]!, label))).toBe("_45_1");
    expect(runtime.learnerAccountId(request(courses[0]!, label))).toBe("_44_1");
    expect(() => runtime.learnerAccountId(request(courses[0]!, "Student A999"))).toThrow("does not hold");
  });

  it("normalizes an encrypted legacy reference only on internal routes in its saved course", async () => {
    const directory = mkdtempSync(join(tmpdir(), "blackboard-legacy-labels-"));
    try {
      const path = join(directory, "learners.json");
      const key = randomBytes(32);
      const iv = randomBytes(12);
      const token = "learner_2f1a5b3c-9d4e-4f6a-8b7c-1d2e3f4a5b6c";
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const records = [{ token, scope: { canvasOrigin: baseUrl, account: tenant.id, course: courses[0], principal: principalId, profile: "blackboard-learn-api" }, identity: { id: "_44_1", name: "Jane Doe" } }];
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(records)), cipher.final()]);
      writeFileSync(`${path}.key`, key.toString("base64url"));
      writeFileSync(path, JSON.stringify({ schema: "morrow.learner-vault.v1", iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") }));
      const runtime = new BlackboardLearnRuntime([tenant], { learnerVault: new LearnerVault(path) });
      const request = (courseId: string) => ({ tenant_id: tenant.id, course_id: courseId, source_binding_id: deriveBlackboardSourceBindingId(baseUrl, principalId, courseId), learner_reference: token });
      await expect(runtime.resolvePublicInput(request(courses[0]!))).rejects.toThrow("Public learner references require readable labels");
      await expect(runtime.resolvePublicInput(request(courses[0]!), undefined, true)).resolves.toMatchObject({ learner_reference: "Student A1" });
      await expect(runtime.resolvePublicInput(request(courses[1]!), undefined, true)).rejects.toThrow("does not resolve in this exact Blackboard course");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });


  it("advertises legacy compatibility only on Gateway-only source routes", async () => {
    const runtime = new BlackboardLearnRuntime([tenant]);
    const client = new Client({ name: "blackboard-label-schema", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [left, right] = InMemoryTransport.createLinkedPair();
    const running = serveStdio(() => createBlackboardLearnMcpServer(runtime, { includePrivateDispatch: true }), { transport: right });
    try {
      await client.connect(left);
      const { tools } = await client.listTools();
      const pattern = (name: string) => {
        const schema = tools.find((tool) => tool.name === name)!.inputSchema as { properties: { learner_reference: { pattern: string } } };
        return new RegExp(schema.properties.learner_reference.pattern);
      };
      const legacy = "learner_2f1a5b3c-9d4e-4f6a-8b7c-1d2e3f4a5b6c";
      expect(pattern("blackboard_plan_membership_patch").test(legacy)).toBe(false);
      expect(pattern("blackboard_apply_reviewed_membership_patch").test(legacy)).toBe(true);
      expect(pattern("blackboard_apply_reviewed_membership_patch").test("Student A1")).toBe(true);
    } finally { await client.close(); await running.close(); }
  });

});
