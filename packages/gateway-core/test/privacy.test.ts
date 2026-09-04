import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ArtifactGenerationRegistry,
  LearnerVault,
  normalizeUpstreamResult,
  resolveLearnerTokens,
  type OutputPrivacyContext,
} from "../src/index.js";

const mapping = {
  publicName: "canvas_learner_get",
  upstreamId: "canvas",
  upstreamLabel: "Canvas",
  upstreamName: "canvas_learner_get",
  inputSchema: { type: "object" },
};
const scope = {
  canvasOrigin: "https://canvas.example.test",
  account: "1",
  course: "42",
  principal: "instructor:7",
  profile: "private-full",
};
const learnerDescriptor = {
  allowedFields: ["learner", "grade", "status"],
  dataClass: "learner" as const,
  maxRecords: 2,
  maxBytes: 2_000,
  freeText: "deny" as const,
  learnerTokens: true,
  artifactInspection: "deny" as const,
  aiClientAdmission: "allow" as const,
};

function normalize(value: unknown, privacy: OutputPrivacyContext) {
  return normalizeUpstreamResult(value, {
    mapping,
    catalogDigest: "a".repeat(64),
    privacy,
  });
}

describe("privacy output boundary", () => {
  it("PRIV-01 sanitizes upstream MCP error content", () => {
    const result = normalize({
      isError: true,
      content: [{ type: "text", text: "Bearer top-secret@example.test" }],
      structuredContent: { csrf: "secret" },
    }, { descriptor: learnerDescriptor });

    expect(JSON.stringify(result)).not.toContain("top-secret");
    expect(result.structuredContent).toMatchObject({ code: "upstream_error_sanitized" });
  });

  it("PRIV-02 tokenizes learner identity and only returns allowed fields", () => {
    const vault = new LearnerVault(":memory:");
    const result = normalize({
      structuredContent: {
        learner: { id: "17", name: "Ada Lovelace", email: "ada@example.test", grade: "A" },
      },
    }, { descriptor: learnerDescriptor, learnerVault: vault, learnerScope: scope });

    expect(result.structuredContent).toMatchObject({
      learner: { learnerToken: expect.stringMatching(/^learner_/), grade: "A" },
    });
    expect(JSON.stringify(result)).not.toContain("Ada Lovelace");
    expect(JSON.stringify(result)).not.toContain("ada@example.test");
  });

  it("PRIV-03 refuses hidden HTML when free text is not explicitly allowed", () => {
    const result = normalize({
      structuredContent: { html: '<span style="display:none">Ada Lovelace</span>' },
    }, {
      descriptor: { ...learnerDescriptor, allowedFields: ["html"], learnerTokens: false },
    });

    expect(result.structuredContent).toMatchObject({ code: "privacy_output_denied" });
    expect(JSON.stringify(result)).not.toContain("Ada Lovelace");
  });

  it("refuses sensitive values after free-text fields are selected", () => {
    const textResult = normalize({
      content: [{ type: "text", text: "Bearer top-secret" }],
    }, { descriptor: { ...learnerDescriptor, freeText: "allow" } });
    const fieldResult = normalize({
      structuredContent: { status: "student@example.test" },
    }, { descriptor: { ...learnerDescriptor, allowedFields: ["status"], freeText: "allow" } });

    expect(textResult.structuredContent).toMatchObject({ code: "privacy_sensitive_text_refused" });
    expect(fieldResult.structuredContent).toMatchObject({ code: "privacy_sensitive_text_refused" });
  });

  it("PRIV-04 refuses opaque artifacts without trusted generation", () => {
    const bytes = Buffer.from("opaque input");
    const result = normalize({
      content: [{ type: "resource", resource: { blob: bytes.toString("base64") } }],
    }, {
      descriptor: { ...learnerDescriptor, artifactInspection: "trusted-generated" },
      artifacts: new ArtifactGenerationRegistry(),
    });

    expect(result.structuredContent).toMatchObject({ code: "privacy_artifact_digest_untrusted" });
  });

  it("PRIV-05 permits exact trusted generated artifact bytes", () => {
    const bytes = Buffer.from("generated report");
    const artifacts = new ArtifactGenerationRegistry();
    artifacts.record(bytes);
    const result = normalize({
      content: [{ type: "resource", resource: { blob: bytes.toString("base64") } }],
    }, {
      descriptor: { ...learnerDescriptor, artifactInspection: "trusted-generated" },
      artifacts,
    });

    expect(result.isError).not.toBe(true);
    expect(result.content).toHaveLength(1);
  });

  it("enforces output record and byte limits", () => {
    const recordLimit = normalize({ structuredContent: { status: ["one", "two"] } }, {
      descriptor: { ...learnerDescriptor, allowedFields: ["status"], learnerTokens: false, maxRecords: 1 },
    });
    expect(recordLimit.structuredContent).toMatchObject({ code: "privacy_record_limit_exceeded" });

    const byteLimit = normalize({ content: [{ type: "text", text: "too long" }] }, {
      descriptor: { ...learnerDescriptor, allowedFields: [], learnerTokens: false, freeText: "allow", maxBytes: 1 },
    });
    expect(byteLimit.structuredContent).toMatchObject({ code: "privacy_byte_limit_exceeded" });
  });

  it("keeps the encrypted learner mapping local and resolves a token only in scope", () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-learner-vault-"));
    const path = join(directory, "vault.json");
    try {
      const vault = new LearnerVault(path);
      const token = vault.tokenize(scope, { id: "17", name: "Ada Lovelace", email: "ada@example.test" });
      expect(readFileSync(path, "utf8")).not.toContain("Ada Lovelace");
      expect(new LearnerVault(path).resolve(scope, token)).toEqual({
        id: "17",
        name: "Ada Lovelace",
        email: "ada@example.test",
      });
      expect(resolveLearnerTokens({ learner_token: token }, vault, scope)).toEqual({ learner_id: "17" });
      expect(() => vault.resolve({ ...scope, course: "43" }, token)).toThrow(/exact scope/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
