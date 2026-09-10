import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ArtifactGenerationRegistry,
  LearnerRoster,
  LearnerVault,
  redactLearnerEgress,
  normalizeUpstreamResult,
  redactKnownLearnerText,
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

function learnerPrivacy(vault = new LearnerVault(":memory:"), identities = [{ id: "17", name: "Ada Lovelace", email: "ada@example.test" }]): OutputPrivacyContext {
  const learnerRoster = new LearnerRoster();
  learnerRoster.register(scope, identities);
  return { descriptor: learnerDescriptor, learnerVault: vault, learnerRoster, learnerScope: scope };
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
    }, learnerPrivacy(vault));

    expect(result.structuredContent).toMatchObject({
      learner: { learnerToken: expect.stringMatching(/^Student A[1-9][0-9]*/), grade: "A" },
    });
    expect(JSON.stringify(result)).not.toContain("Ada Lovelace");
    expect(JSON.stringify(result)).not.toContain("ada@example.test");
  });

  it("PRIV-03 refuses hidden HTML when free text is not explicitly allowed", () => {
    const result = normalize({
      structuredContent: { html: '<span style="display:none">Ada Lovelace</span>' },
    }, { ...learnerPrivacy(), descriptor: { ...learnerDescriptor, allowedFields: ["html"], learnerTokens: false } });

    expect(result.structuredContent).toMatchObject({ code: "privacy_output_denied" });
    expect(JSON.stringify(result)).not.toContain("Ada Lovelace");
  });

  it("refuses sensitive values after free-text fields are selected", () => {
    const textResult = normalize({
      content: [{ type: "text", text: "Bearer top-secret" }],
    }, { ...learnerPrivacy(), descriptor: { ...learnerDescriptor, freeText: "allow" } });
    const fieldResult = normalize({
      structuredContent: { status: "student@example.test" },
    }, { ...learnerPrivacy(), descriptor: { ...learnerDescriptor, allowedFields: ["status"], freeText: "allow" } });

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
      ...learnerPrivacy(), descriptor: { ...learnerDescriptor, allowedFields: ["status"], learnerTokens: false, maxRecords: 1 },
    });
    expect(recordLimit.structuredContent).toMatchObject({ code: "privacy_record_limit_exceeded" });

    const byteLimit = normalize({ content: [{ type: "text", text: "too long" }] }, {
      ...learnerPrivacy(), descriptor: { ...learnerDescriptor, allowedFields: [], learnerTokens: false, freeText: "allow", maxBytes: 1 },
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

  it("migrates existing encrypted UUID mappings to stable readable labels across restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-learner-vault-migration-"));
    const path = join(directory, "vault.json");
    try {
      const original = new LearnerVault(path);
      original.tokenize(scope, { id: "17", name: "Ada Lovelace" });
      const envelope = JSON.parse(readFileSync(path, "utf8"));
      const key = Buffer.from(readFileSync(`${path}.key`, "utf8").trim(), "base64url");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      const entries = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]).toString("utf8"));
      const oldToken = entries[0].token;
      delete entries[0].label;
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(entries)), cipher.final()]);
      writeFileSync(path, JSON.stringify({ ...envelope, iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") }));
      const migrated = new LearnerVault(path);
      expect(migrated.tokenize(scope, { id: "17" })).toBe("Student A1");
      expect(migrated.resolve(scope, oldToken).id).toBe("17");
      expect(migrated.resolve(scope, "Student A1").name).toBe("Ada Lovelace");
      expect(migrated.tokenize(scope, { id: "18", name: "Rowan Clarke" })).toBe("Student A2");
      const restarted = new LearnerVault(path);
      expect(restarted.resolve(scope, "Student A1").id).toBe("17");
      expect(restarted.resolve(scope, "Student A2").id).toBe("18");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("refuses malformed and conflicting encrypted legacy vault records at load time", () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-invalid-learner-vault-"));
    const path = join(directory, "vault.json");
    const token = "learner_11111111-1111-4111-8111-111111111111";
    const otherToken = "learner_22222222-2222-4222-8222-222222222222";
    const record = { token, scope, identity: { id: "17", name: "Michaela Adams" } };
    const cases = [
      [{ ...record, token: "learner_bad" }],
      [record, { ...record, scope: { ...scope, course: "43" }, identity: { id: "18" } }],
      [record, { ...record, token: otherToken }],
      [record, { ...record, token: otherToken, identity: { id: "17", name: "Different Person" } }],
      [{ ...record, label: "Student A1" }, { ...record, token: otherToken, label: "Student A1", identity: { id: "18" } }],
    ];
    try {
      const key = randomBytes(32);
      writeFileSync(`${path}.key`, key.toString("base64url"));
      for (const entries of cases) {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(entries)), cipher.final()]);
        writeFileSync(path, JSON.stringify({ schema: "morrow.learner-vault.v1", iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") }));
        expect(() => new LearnerVault(path)).toThrow(/learner vault/);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("requires a complete exact-scope roster before learner output can leave the gateway", () => {
    const result = normalize({ structuredContent: { status: "ready" } }, {
      descriptor: learnerDescriptor,
      learnerVault: new LearnerVault(":memory:"),
      learnerScope: scope,
    });

    expect(result.structuredContent).toMatchObject({ code: "learner_roster_scope_unavailable" });
  });

  it("leaves a clock field or score that equals a learner's platform id alone, and still redacts the id in context", () => {
    const vault = new LearnerVault(":memory:");
    const learnerRoster = new LearnerRoster();
    learnerRoster.register(scope, [{ id: "17", name: "Ada Lovelace", email: "ada@example.test" }]);
    const token = vault.tokenize(scope, { id: "17", name: "Ada Lovelace", email: "ada@example.test" });
    const context = { learnerRoster, learnerVault: vault, learnerScope: scope };
    const stamp = "2026-09-10T21:17:00.748Z";

    for (const machineText of [stamp, "17/20 points", "page 17 of 40"]) {
      expect(redactKnownLearnerText(machineText, context)).toBe(machineText);
    }
    // The whole string being the id is the one bare form that names a person.
    expect(redactKnownLearnerText("17", context)).toBe(token);
    expect(redactLearnerEgress({ recipients: ["17"], established_at: stamp }, context)).toEqual({ recipients: [token], established_at: stamp });
    expect(redactKnownLearnerText(`Graded user_id: 17 at ${stamp}`, context)).toBe(`Graded user_id: ${token} at ${stamp}`);
    expect(redactKnownLearnerText('<a data-user-id="17" href="/users/17">Ada Lovelace</a>', context))
      .toBe(`<a data-user-id="${token}" href="/users/${token}">${token}</a>`);
    expect(redactLearnerEgress({ established_at: stamp, note: "Ada Lovelace" }, context))
      .toEqual({ established_at: stamp, note: token });
  });

  it("redacts known roster aliases in Unicode and HTML text while preserving course IDs", () => {
    const vault = new LearnerVault(":memory:");
    const learnerRoster = new LearnerRoster();
    learnerRoster.register(scope, [
      { id: "17", name: "Ada Lovelace", email: "ada@example.test" },
      { id: "21", name: "Élodie Durand", email: "elodie@example.test" },
    ]);
    const adaToken = vault.tokenize(scope, { id: "17", name: "Ada Lovelace", email: "ada@example.test" });
    const elodieToken = vault.tokenize(scope, { id: "21", name: "Élodie Durand", email: "elodie@example.test" });
    const text = redactKnownLearnerText(
      '<p>Student ID: 17, Ada&nbsp;Lovelace, Ada%20Lovelace, ada&#64;example.test, and Élodie Durand. Course 42 remains. <a data-user-id="17">record</a></p>',
      { learnerRoster, learnerVault: vault, learnerScope: scope },
    );

    expect(text).toContain(adaToken);
    expect(text).toContain(elodieToken);
    expect(text).toContain("Course 42 remains");
    expect(text).not.toContain("Ada");
    expect(text).not.toContain("Ada%20Lovelace");
    expect(text).not.toContain("ada@example.test");
    expect(text).not.toContain("Élodie");
    expect(text).not.toContain("Student ID: 17");
    expect(text).not.toContain('data-user-id="17"');
  });

  it("preserves unmatched approval URL bytes while replacing encoded roster aliases and IDs", () => {
    const vault = new LearnerVault(":memory:");
    const learnerRoster = new LearnerRoster();
    learnerRoster.register(scope, [{ id: "17", name: "Ada Lovelace", email: "ada@example.test" }]);
    const token = vault.tokenize(scope, { id: "17", name: "Ada Lovelace", email: "ada@example.test" });
    const approvalUrl = "http://127.0.0.1:4317/operations/op%3Aaa%2Fbb?next=%2Foperations%2Fop%3Acc&amp;state=ready";
    const source = `${approvalUrl}&learner=Ada%20Lovelace&amp;email=ada&#64;example.test <a data-user-id=\"17\" href=\"/users/17?return=op%3Aaa%2Fbb&amp;safe=%26amp%3B\">Ada&nbsp;Lovelace</a>`;
    const redacted = redactKnownLearnerText(source, { learnerRoster, learnerVault: vault, learnerScope: scope });

    expect(redactKnownLearnerText(approvalUrl, { learnerRoster, learnerVault: vault, learnerScope: scope })).toBe(approvalUrl);
    expect(redacted).toBe(`${approvalUrl}&learner=${token}&amp;email=${token} <a data-user-id=\"${token}\" href=\"/users/${token}?return=op%3Aaa%2Fbb&amp;safe=%26amp%3B\">${token}</a>`);
    expect(redactKnownLearnerText("🧪 Ada%20Lovelace", { learnerRoster, learnerVault: vault, learnerScope: scope })).toBe(`🧪 ${token}`);
  });

  it("keeps percent escapes outside a matching alias byte-exact", () => {
    const vault = new LearnerVault(":memory:");
    const learnerRoster = new LearnerRoster();
    learnerRoster.register(scope, [{ id: "18", name: "Jane Doe" }]);
    const token = vault.tokenize(scope, { id: "18", name: "Jane Doe" });
    const source = "value=%4A%61%6E%65%20%44%6F%65%20%61%62%63";

    expect(redactKnownLearnerText(source, { learnerRoster, learnerVault: vault, learnerScope: scope }))
      .toBe(`value=${token}%20%61%62%63`);
  });

  it("matches full NFKC learner aliases across grapheme starter boundaries", () => {
    const vault = new LearnerVault(":memory:");
    const learnerRoster = new LearnerRoster();
    learnerRoster.register(scope, [{ id: "19", name: "가 Doe" }]);
    const token = vault.tokenize(scope, { id: "19", name: "가 Doe" });
    const context = { learnerRoster, learnerVault: vault, learnerScope: scope };

    expect(redactKnownLearnerText("가 Doe", context)).toBe(token);
    expect(redactKnownLearnerText("%E1%84%80%E1%85%A1%20Doe", context)).toBe(token);
  });

  it("refuses encoded credentials and unrostered email after exact-scope alias redaction", () => {
    const context = learnerPrivacy();
    const descriptor = { ...learnerDescriptor, allowedFields: ["status"], freeText: "allow" as const };
    const credential = normalize({ structuredContent: { status: "Bearer%20secret-value" } }, { ...context, descriptor });
    const unrostered = normalize({ structuredContent: { status: "outside&#64;example.test" } }, { ...context, descriptor });

    expect(credential.structuredContent).toMatchObject({ code: "privacy_sensitive_text_refused" });
    expect(unrostered.structuredContent).toMatchObject({ code: "privacy_sensitive_text_refused" });
  });

  it("uses a generic marker for a known alias shared by multiple learners", () => {
    const vault = new LearnerVault(":memory:");
    const learnerRoster = new LearnerRoster();
    learnerRoster.register(scope, [
      { id: "17", name: "Jordan Lee", email: "jordan.one@example.test" },
      { id: "18", name: "Jordan Lee", email: "jordan.two@example.test" },
    ]);

    const text = redactKnownLearnerText("Jordan Lee submitted the assignment.", { learnerRoster, learnerVault: vault, learnerScope: scope });

    expect(text).toBe("[learner] submitted the assignment.");
    expect(redactKnownLearnerText("Jordan%20Lee submitted the assignment.", { learnerRoster, learnerVault: vault, learnerScope: scope }))
      .toBe("[learner] submitted the assignment.");
  });

  it("refuses opaque resource bytes before a learner envelope can leave the gateway", () => {
    const context = learnerPrivacy();

    expect(() => redactLearnerEgress(
      { resource: { blob: Buffer.from("Jane Doe").toString("base64") } },
      {
        learnerRoster: context.learnerRoster!,
        learnerVault: context.learnerVault!,
        learnerScope: context.learnerScope!,
      },
    )).toThrow("privacy_resource_blob_refused");
  });

  it("removes private attachment handles and encoded bytes from arbitrary learner egress", () => {
    const context = learnerPrivacy();
    const output = redactLearnerEgress(
      {
        status: "ready",
        privateAttachment: { handle: "stage:secret", bytes_base64: Buffer.from("Jane Doe").toString("base64") },
      },
      {
        learnerRoster: context.learnerRoster!,
        learnerVault: context.learnerVault!,
        learnerScope: context.learnerScope!,
      },
    );

    expect(output).toEqual({ status: "ready" });
  });

  it("does not use aliases or tokens from another exact learner scope", () => {
    const vault = new LearnerVault(":memory:");
    const learnerRoster = new LearnerRoster();
    const otherScope = { ...scope, course: "43", principal: "instructor:8" };
    learnerRoster.register(scope, [{ id: "17", name: "Ada Lovelace", email: "ada@example.test" }]);
    learnerRoster.register(otherScope, [{ id: "88", name: "Rowan Clarke", email: "rowan@example.test" }]);

    const first = redactKnownLearnerText("Ada Lovelace and Rowan Clarke", { learnerRoster, learnerVault: vault, learnerScope: scope });
    const second = redactKnownLearnerText("Ada Lovelace and Rowan Clarke", { learnerRoster, learnerVault: vault, learnerScope: otherScope });

    expect(first).toMatch(/^Student A[1-9][0-9]*/);
    expect(first).toContain("Rowan Clarke");
    expect(second).toContain("Ada Lovelace");
    expect(second).toMatch(/Student A[1-9][0-9]*$/);
    expect(vault.resolve(otherScope, vault.tokenize(otherScope, { id: "17" })).id).toBe("17");
    expect(vault.tokenize(scope, { id: "17" })).toBe("Student A1");
  });

  it("applies roster aliases at the content boundary before learner free text is returned", () => {
    const vault = new LearnerVault(":memory:");
    const result = normalize({
      content: [{ type: "text", text: "Feedback for Ada Lovelace is ready." }],
    }, {
      ...learnerPrivacy(vault),
      descriptor: { ...learnerDescriptor, freeText: "allow", maxBytes: 2_000 },
    });

    expect(JSON.stringify(result)).not.toContain("Ada Lovelace");
    expect(result.content[0]).toMatchObject({ text: expect.stringMatching(/Student A[1-9][0-9]*/) });
  });

  it("redacts a native envelope without dropping its schema or instructional context", () => {
    const vault = new LearnerVault(":memory:");
    const learnerRoster = new LearnerRoster();
    learnerRoster.register(scope, [
      { id: "17", name: "Jane Doe", email: "jane@example.test" },
      { id: "18", name: "C. Zarate", email: "zarate@example.test" },
      { id: "19", name: "D. Quintero", email: "quintero@example.test" },
    ]);
    const result = redactLearnerEgress({
      schema: "morrow.native-review.v1",
      content: [{ type: "text", text: "Multiple Choice. True/False. A. Stratum corneum. Options: A. Probe, B. Mirror, C. Cotton pliers, D. Explorer." }],
      structuredContent: {
        schema: "morrow.lesson-evidence.v1",
        course: { id: "42", title: "Anatomy" },
        summary: "Student Jane Doe scored 88. Gradebook rows: C. Zarate and D. Quintero.",
        learner: { id: "17", name: "Jane Doe", email: "jane@example.test", score: 88 },
        accessToken: "never-return-this",
      },
    }, { learnerRoster, learnerVault: vault, learnerScope: scope }) as Record<string, unknown>;
    const serialized = JSON.stringify(result);

    expect((result as { schema: string }).schema).toBe("morrow.native-review.v1");
    expect(serialized).toContain("morrow.lesson-evidence.v1");
    expect(serialized).toContain('"id":"42"');
    expect(serialized).toContain("Multiple Choice");
    expect(serialized).toContain("True/False");
    expect(serialized).toContain("A. Stratum corneum");
    expect(serialized).toContain("Options: A. Probe, B. Mirror, C. Cotton pliers, D. Explorer");
    expect(serialized).toMatch(/Student A[1-9][0-9]*/);
    expect(serialized).not.toContain("Jane Doe");
    expect(serialized).not.toContain("C. Zarate");
    expect(serialized).not.toContain("D. Quintero");
    expect(serialized).not.toContain("never-return-this");
  });

  it("refuses an identity record that conflicts with the authoritative exact-scope roster", () => {
    const vault = new LearnerVault(":memory:");
    const learnerRoster = new LearnerRoster();
    learnerRoster.register(scope, [{ id: "17", name: "Ada Lovelace", email: "ada@example.test" }]);

    expect(() => redactLearnerEgress({ learner: { id: "17", name: "Different Name", grade: "A" } }, {
      learnerRoster, learnerVault: vault, learnerScope: scope,
    })).toThrow("learner_roster_identity_conflict");
  });

  it("tokenizes generic learner, enrollment, submission, and grade records recursively", () => {
    const vault = new LearnerVault(":memory:");
    const result = normalize({
      structuredContent: {
        course: { id: "42", name: "Biology" },
        learner: { id: "17", name: "Ada Lovelace", email: "ada@example.test", grade: "A" },
        enrollments: [{ user_id: "17", user: { id: "17", name: "Ada Lovelace" }, role: "StudentEnrollment" }],
        submissions: [{ id: "submission-1", user_id: "17", score: 9, comment: "Ada Lovelace submitted work." }],
        grades: [{ id: "17", current_grade: "A" }],
      },
    }, {
      ...learnerPrivacy(vault),
      descriptor: { ...learnerDescriptor, allowedFields: [], fieldPolicy: "scrub-sensitive", freeText: "allow" },
    });

    expect(result.structuredContent).toMatchObject({
      course: { id: "42", name: "Biology" },
      learner: { learnerToken: expect.stringMatching(/^Student A[1-9][0-9]*/), grade: "A" },
      enrollments: [{ learnerToken: expect.stringMatching(/^Student A[1-9][0-9]*/), role: "StudentEnrollment" }],
      submissions: [{ learnerToken: expect.stringMatching(/^Student A[1-9][0-9]*/), score: 9, comment: expect.stringMatching(/^Student A[1-9][0-9]*/) }],
      grades: [{ learnerToken: expect.stringMatching(/^Student A[1-9][0-9]*/), current_grade: "A" }],
    });
    expect(JSON.stringify(result)).not.toContain("Ada Lovelace");
    expect(JSON.stringify(result)).not.toContain("ada@example.test");
  });

  it("normalizes identity field spellings before tokenizing a generic learner record", () => {
    const result = normalize({
      structuredContent: {
        learners: [{ "USER-ID": "17", "DISPLAY-NAME": "Ada Lovelace", Primary_Email: "ada@example.test", grade: "A" }],
      },
    }, {
      ...learnerPrivacy(),
      descriptor: { ...learnerDescriptor, allowedFields: [], fieldPolicy: "scrub-sensitive" },
    });

    expect(result.structuredContent).toMatchObject({
      learners: [{ learnerToken: expect.stringMatching(/^Student A[1-9][0-9]*/), grade: "A" }],
    });
    expect(JSON.stringify(result)).not.toContain("Ada Lovelace");
    expect(JSON.stringify(result)).not.toContain("ada@example.test");
  });

  it("fails closed when an identity-bearing record has no resolvable learner identity", () => {
    const result = normalize({
      structuredContent: { enrollments: [{ role: "StudentEnrollment", current_grade: "A" }] },
    }, {
      ...learnerPrivacy(),
      descriptor: { ...learnerDescriptor, allowedFields: [], fieldPolicy: "scrub-sensitive" },
    });

    expect(result.structuredContent).toMatchObject({ code: "privacy_identity_record_unresolved" });
    expect(JSON.stringify(result)).not.toContain("StudentEnrollment");
  });

  it("scrubs learner and credential fields while retaining complete course objects", () => {
    const vault = new LearnerVault(":memory:");
    const result = normalize({
      structuredContent: {
        course: { id: "42", name: "Biology", workflow_state: "available" },
        user: { id: "17", name: "Ada Lovelace", email: "ada@example.test", role: "Teacher" },
        access_token: "never-return-this",
      },
    }, {
      ...learnerPrivacy(vault),
      descriptor: { ...learnerDescriptor, allowedFields: [], fieldPolicy: "scrub-sensitive", freeText: "allow" },
    });
    expect(result.structuredContent).toMatchObject({
      course: { id: "42", name: "Biology", workflow_state: "available" },
      user: { learnerToken: expect.stringMatching(/^Student A[1-9][0-9]*/), role: "Teacher" },
    });
    expect(JSON.stringify(result)).not.toContain("never-return-this");
    expect(JSON.stringify(result)).not.toContain("Ada Lovelace");
  });

  it("redacts roster aliases and removes unknown learner-shaped fields in course data", () => {
    const vault = new LearnerVault(":memory:");
    const result = normalize({
      structuredContent: {
        audit: {
          student_name: "Ada Lovelace",
          custom_learner_id: "17",
          narrative: "Ada Lovelace submitted work.",
        },
      },
    }, {
      ...learnerPrivacy(vault),
      descriptor: {
        ...learnerDescriptor,
        allowedFields: [],
        fieldPolicy: "scrub-sensitive",
        dataClass: "course",
        freeText: "allow",
        learnerTokens: false,
      },
    });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("Ada Lovelace");
    expect(serialized).not.toContain("custom_learner_id");
    expect(serialized).not.toContain('"17"');
    expect(serialized).toMatch(/Student A[1-9][0-9]* submitted work/);
  });
});

describe("complete roster structured identity regression", () => {
  const person = {
    id: "9001", name: "Jane Alexandra Doe", email: "jane@example.test", loginId: "jdoe",
    sisUserId: "SIS-9081", aliases: ["Doe, Jane Alexandra", "Janie", "jane.integration", "Jane", "Doe"],
  };
  function context(course = "42") {
    const learnerRoster = new LearnerRoster();
    const learnerScope = { ...scope, course };
    learnerRoster.register(learnerScope, [person]);
    return { learnerRoster, learnerScope, learnerVault: new LearnerVault(":memory:") };
  }
  it("removes aliases, profile fields, participant IDs and identifiers in report keys", () => {
    const ctx = context();
    const output = redactLearnerEgress({
      report: [{ id: "9001", name: person.name, grade: "A", sortable_name: person.aliases[0], short_name: "Janie", integration_id: "jane.integration", pronouns: "she/her", profile: { city: "Private Town" } }],
      authors: [{ id: "9001", name: person.name, score: 99 }],
      participants: [{ id: "9001", name: person.name }],
      byStudent: { "9001": { status: "submitted" } },
      debug: { "SIS-9081": "Janie used jane.integration and jdoe" },
      participant_ids: ["9001"], author_id: "9001",
    }, ctx);
    const serialized = JSON.stringify(output);
    for (const privateValue of [person.id, person.name, person.email, person.loginId, person.sisUserId, ...person.aliases, "she/her", "Private Town"]) expect(serialized).not.toContain(privateValue);
    expect(serialized).toContain('"grade":"A"');
    expect(serialized).toContain('"score":99');
  });
  it("refuses unknown generic learner reports and ambiguous keyed projections", () => {
    const ctx = context();
    expect(() => redactLearnerEgress({ rows: [{ id: "9002", name: "Unknown Person", grade: 90 }] }, ctx)).toThrow("learner_roster_identity_unavailable");
    expect(() => redactLearnerEgress({ byStudent: { Janie: 90, "Jane Alexandra Doe": 91 } }, ctx)).toThrow("privacy_identity_key_collision");
  });
  it("redacts JSON embedded in MCP text and refuses unknown nested learners", () => {
    const ctx = context();
    const output = redactLearnerEgress({ content: [{ type: "text", text: JSON.stringify({ users: [{ id: "9001", name: person.name, integration_id: "jane.integration" }] }) }] }, ctx);
    expect(JSON.stringify(output)).not.toContain("9001");
    expect(JSON.stringify(output)).not.toContain(person.name);
    expect(() => redactLearnerEgress(JSON.stringify({ users: [{ id: "unknown", name: "Unknown Person" }] }), ctx)).toThrow("learner_roster_identity_unavailable");
  });
  it("isolates course tokens and refuses expired or duplicate roster snapshots", () => {
    const ctx = context();
    const other = { ...context("43"), learnerVault: ctx.learnerVault };
    expect(redactKnownLearnerText("Janie", ctx)).toBe("Student A1");
    expect(redactKnownLearnerText("Janie", other)).toBe("Student A1");
    expect(() => ctx.learnerVault.resolve({ ...scope, course: "44" }, "Student A1")).toThrow();
    expect(() => ctx.learnerRoster.register(ctx.learnerScope, [person, person])).toThrow();
    const originalNow = Date.now;
    const future = originalNow() + 60_001;
    try {
      Date.now = () => future;
      expect(() => redactLearnerEgress({ status: "complete" }, ctx)).toThrow("learner_roster_scope_unavailable");
    } finally { Date.now = originalNow; }
  });
});

describe("bidirectional roster dictionary", () => {
  it("replaces unique given names everywhere and never resolves an ambiguous given name", () => {
    const roster = new LearnerRoster();
    roster.register(scope, [{ id: "501", name: "Michaela Adams" }, { id: "502", name: "Alex Smith" }, { id: "503", name: "Alex Jones" }]);
    const ctx = { learnerRoster: roster, learnerScope: scope, learnerVault: new LearnerVault(":memory:") };
    const token = redactKnownLearnerText("Michaela Adams", ctx);
    expect(redactKnownLearnerText("Michaela wrote a message. Adams replied.", ctx)).toBe(`${token} wrote a message. Adams replied.`);
    expect(redactKnownLearnerText("Alex replied.", ctx)).toBe("[learner] replied.");
    expect(redactLearnerEgress({ outer: [{ body: "Michaela Adams replied to Michaela.", nested: { Michaela: "Alex replied." } }] }, ctx))
      .toEqual({ outer: [{ body: `${token} replied to ${token}.`, nested: { [token]: "[learner] replied." } }] });
    const request = resolveLearnerTokens({ user_id: token, body: `Hello ${token}.`, nested: { [token]: "selected" } }, ctx.learnerVault, scope, roster);
    expect(request).toEqual({ user_id: "501", body: "Hello Michaela Adams.", nested: { "501": "selected" } });
    roster.register(scope, []);
    expect(() => resolveLearnerTokens({ body: `Hello ${token}.` }, ctx.learnerVault, scope, roster)).toThrow("learner_roster_identity_unavailable");
  });
  it("replaces numeric identity values without changing typed course IDs or grades", () => {
    const roster = new LearnerRoster(); roster.register(scope, [{ id: "17", name: "Ada Lovelace" }]);
    const ctx = { learnerRoster: roster, learnerScope: scope, learnerVault: new LearnerVault(":memory:") };
    const output = redactLearnerEgress({ references: [17], course_id: 17, course: { id: 17 }, score: 17, user: { id: 17, name: "Ada Lovelace" } }, ctx) as Record<string, unknown>;
    expect(output.references).toEqual([expect.stringMatching(/^Student A[1-9][0-9]*/)]);
    expect(output.course_id).toBe(17); expect(output.course).toEqual({ id: 17 }); expect(output.score).toBe(17);
    expect(() => redactLearnerEgress({ content: [{ type: "image", data: Buffer.from("Ada Lovelace").toString("base64") }] }, ctx)).toThrow("privacy_opaque_artifact_refused");
  });

  it("preserves structural identifiers while redacting learner text", () => {
    const roster = new LearnerRoster();
    roster.register(scope, [{ id: "learner-canvas:a:101", name: "Canvas A Learner 101" }]);
    const ctx = { learnerRoster: roster, learnerScope: scope, learnerVault: new LearnerVault(":memory:") };
    const output = redactLearnerEgress({
      source_binding_id: "canvas:a:101",
      sourceBindingId: "canvas:a:101",
      course_id: "101",
      courseId: "101",
      childId: "audit:canvas:a:101",
      operationId: "op:canvas:a:101",
      operationKey: "canvas:a:101",
      body: "Canvas A Learner 101 replied.",
    }, ctx);
    expect(output).toEqual({
      source_binding_id: "canvas:a:101",
      sourceBindingId: "canvas:a:101",
      course_id: "101",
      courseId: "101",
      childId: "audit:canvas:a:101",
      operationId: "op:canvas:a:101",
      operationKey: "canvas:a:101",
      body: "Student A1 replied.",
    });
  });
});

describe("readable learner labels survive a restart", () => {
  it("keeps the saved course dictionary stable and resolves only the selected course", () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-readable-labels-"));
    try {
      const path = join(directory, "learners.json");
      const first = new LearnerVault(path);
      expect(first.tokenize(scope, { id: "17", name: "Michaela Adams" })).toBe("Student A1");
      expect(first.tokenize(scope, { id: "18", name: "Jamie Reed" })).toBe("Student A2");
      const other = { ...scope, course: "43" };
      expect(first.tokenize(other, { id: "29", name: "Taylor Lane" })).toBe("Student A1");
      const reloaded = new LearnerVault(path);
      expect(reloaded.tokenize(scope, { id: "18", name: "Jamie Reed" })).toBe("Student A2");
      expect(reloaded.tokenize(scope, { id: "17", name: "Michaela Adams" })).toBe("Student A1");
      expect(reloaded.resolve(scope, "Student A1").id).toBe("17");
      expect(reloaded.resolve(other, "Student A1").id).toBe("29");
      expect(() => reloaded.resolve(other, "Student A2")).toThrow();
      expect(() => reloaded.resolve({ ...scope, principal: "different" }, "Student A1")).toThrow();
      const stored = readFileSync(path, "utf8");
      for (const value of ["Michaela", "Jamie", "Taylor", "Student A1"]) expect(stored).not.toContain(value);
      const roster = new LearnerRoster(); roster.register(scope, [{ id: "17", name: "Michaela Adams" }, { id: "18", name: "Jamie Reed" }]);
      const ctx = { learnerRoster: roster, learnerVault: reloaded, learnerScope: scope };
      expect(redactLearnerEgress({ text: "Student A1 replied to Michaela." }, ctx)).toEqual({ text: "Student A1 replied to Student A1." });
      expect(resolveLearnerTokens({ recipients: ["Student A1", "Student A2"], body: "Hello Student A1." }, reloaded, scope, roster)).toEqual({ recipients: ["17", "18"], body: "Hello Michaela Adams." });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
