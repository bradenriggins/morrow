import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Counts every durable vault transaction, so a regression that reopens the
// vault per reference or per scope fails on the count, not on the clock.
const vaultTransactions = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/private-state-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/private-state-file.js")>();
  return {
    ...actual,
    withExactPrivateStateFileTransaction: (...args: Parameters<typeof actual.withExactPrivateStateFileTransaction>) => {
      vaultTransactions.count += 1;
      return actual.withExactPrivateStateFileTransaction(...args);
    },
  };
});
import {
  ArtifactGenerationRegistry,
  LearnerRoster,
  LearnerVault,
  projectOutput,
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

  it("retains only the closed provider outcome from a Canvas read failure", () => {
    const result = normalize({
      isError: true,
      content: [{ type: "text", text: "Canvas said secret learner data" }],
      structuredContent: {
        schema: "morrow.canvas-connector.result.v1",
        ok: false,
        provider: "canvas",
        resultState: "not_sent",
        providerFailure: { schema: "morrow.canvas-browser-failure.v1", provider: "canvas", sent: true, status: 404 },
        problem: { schema: "morrow.bridge.problem.v1", code: "canvas_request_failed", message: "secret learner data" },
      },
    }, { descriptor: learnerDescriptor });
    expect(result.structuredContent).toEqual({
      schema: "morrow.problem.v1",
      code: "upstream_error_sanitized",
      recoverable: false,
      resultState: "not_sent",
      providerFailure: { schema: "morrow.canvas-browser-failure.v1", provider: "canvas", sent: true, status: 404 },
      sourceCode: "canvas_request_failed",
    });
    expect(result.content).toEqual([{ type: "text", text: "Canvas could not find this item (HTTP 404)." }]);
    expect(JSON.stringify(result)).not.toContain("secret learner data");
    expect(JSON.stringify(result)).not.toContain("unsafe");
  });

  it("names the provider outcome instead of an unsafe-output refusal for each status class", () => {
    const text = (providerFailure: Record<string, unknown>) => normalize({
      isError: true,
      structuredContent: { schema: "morrow.canvas-connector.result.v1", ok: false, providerFailure },
    }, { descriptor: learnerDescriptor }).content;
    const failure = { schema: "morrow.canvas-browser-failure.v1", provider: "canvas", sent: true };
    expect(text({ ...failure, status: 403 })).toEqual([{ type: "text", text: "Canvas refused this request for the signed-in account (HTTP 403)." }]);
    expect(text({ ...failure, status: 429 })).toEqual([{ type: "text", text: "Canvas limited the request rate (HTTP 429). Try again later." }]);
    expect(text({ ...failure, status: 503 })).toEqual([{ type: "text", text: "Canvas reported a server error (HTTP 503)." }]);
    expect(text({ ...failure, status: 400 })).toEqual([{ type: "text", text: "Canvas rejected this request (HTTP 400)." }]);
    expect(text({ schema: "morrow.canvas-browser-failure.v1", provider: "moodle", sent: false })).toEqual([{ type: "text", text: "Morrow did not send this request to Moodle." }]);
  });

  // The Bridge's own message is dropped here, so its reason is named from Morrow's code alone. A
  // course tab that closed, or a Bridge that is not connected, is a step for the person to take,
  // not unsafe output.
  it("names Morrow Bridge's reason for a request it did not send, and keeps whether trying again can work", () => {
    const refused = (code: string, recoverable?: boolean) => normalize({
      isError: true,
      content: [{ type: "text", text: "Morrow sent nothing: the Canvas site tab for Biology 101 is not open and signed in." }],
      structuredContent: {
        schema: "morrow.canvas-connector.result.v1",
        ok: false,
        provider: "canvas",
        resultState: "not_sent",
        problem: {
          schema: "morrow.bridge.problem.v1", code,
          message: "Morrow sent nothing: the Canvas site tab for Biology 101 is not open and signed in.",
          ...(recoverable === undefined ? {} : { recoverable }),
        },
      },
    }, { descriptor: learnerDescriptor });
    const closedTab = refused("canvas_binding_required", true);
    expect(closedTab.content).toEqual([{ type: "text", text: "Morrow sent nothing, because the signed-in Canvas or Moodle tab for this course is closed, signed out, or showing another page. Open the course in Canvas or Moodle and sign in, then ask again. If the course is closed, select Open Canvas or Open Moodle in the Morrow Bridge popup." }]);
    expect(closedTab.structuredContent).toEqual({
      schema: "morrow.problem.v1", code: "upstream_error_sanitized", recoverable: true, resultState: "not_sent", sourceCode: "canvas_binding_required",
    });
    expect(JSON.stringify(closedTab)).not.toContain("Biology");
    expect(refused("bridge_unavailable", true).content).toEqual([{ type: "text", text: "Morrow Bridge is not connected to Morrow, so Morrow could not reach the course. Open Chrome and open the Morrow Bridge popup, which shows the step that connects it. Then ask again." }]);
    expect(refused("bridge_port_in_use", true).content).toEqual([{ type: "text", text: "Another Morrow is already connected to Morrow Bridge, so this Morrow could not reach the course. Close the other Morrow, or use one Morrow for all your assistants." }]);
    expect(refused("course_binding_mismatch", true).content).toEqual([{ type: "text", text: "This request names a course that is not the one this Morrow connection carries, so Morrow sent nothing to the course. Connect that course in Morrow Bridge, or ask for this in the connected course." }]);
    const unnamed = refused("operation_catalog_mismatch", false);
    expect(unnamed.content).toEqual([{ type: "text", text: "Morrow Bridge could not complete this request." }]);
    expect(unnamed.structuredContent).toMatchObject({ recoverable: false, sourceCode: "operation_catalog_mismatch" });
    // A source that does not say whether trying again can work is not told it can.
    expect(refused("canvas_binding_required").structuredContent).toMatchObject({ recoverable: false });
    for (const result of [closedTab, unnamed]) expect(JSON.stringify(result)).not.toContain("unsafe");
  });

  it("does not retain malformed or extended provider failure records", () => {
    const result = normalize({
      isError: true,
      structuredContent: {
        schema: "morrow.canvas-connector.result.v1",
        ok: false,
        providerFailure: { schema: "morrow.canvas-browser-failure.v1", provider: "canvas", sent: true, status: 404, body: "secret" },
      },
    }, { descriptor: learnerDescriptor });
    expect(result.structuredContent).toEqual({ schema: "morrow.problem.v1", code: "upstream_error_sanitized", recoverable: false });
    expect(result.content).toEqual([{ type: "text", text: "Morrow refused unsafe upstream output." }]);
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

  it("refuses a credential after free-text fields are selected, and removes an address instead", () => {
    const textResult = normalize({
      content: [{ type: "text", text: "Bearer top-secret" }],
    }, { ...learnerPrivacy(), descriptor: { ...learnerDescriptor, freeText: "allow" } });
    // An address names nobody once it is removed, so the reading itself is
    // returned without it. Refusing the whole reading made Canvas routes that
    // always carry an institutional address impossible to use.
    const fieldResult = normalize({
      structuredContent: { status: "student@example.test" },
    }, { ...learnerPrivacy(), descriptor: { ...learnerDescriptor, allowedFields: ["status"], freeText: "allow" } });

    expect(textResult.structuredContent).toMatchObject({ code: "privacy_sensitive_text_refused" });
    expect(fieldResult.structuredContent).toMatchObject({ status: "[address removed]" });
    expect(JSON.stringify(fieldResult)).not.toContain("student@example.test");
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

  it("admits only exact private bounded learner-vault state", () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-learner-vault-state-"));
    const path = join(directory, "vault.json");
    try {
      const vault = new LearnerVault(path);
      vault.tokenize(scope, { id: "17", name: "Ada Lovelace" });
      if (process.platform !== "win32") {
        expect(lstatSync(path).mode & 0o077).toBe(0);
        expect(lstatSync(`${path}.key`).mode & 0o077).toBe(0);

        chmodSync(`${path}.key`, 0o644);
        expect(() => new LearnerVault(path)).toThrow(/key is not one exact private file/);
        chmodSync(`${path}.key`, 0o600);

        const keyAlias = join(directory, "key-alias");
        linkSync(`${path}.key`, keyAlias);
        expect(() => new LearnerVault(path)).toThrow(/key is not one exact private file/);
        rmSync(keyAlias);

        const stored = join(directory, "stored-vault.json");
        renameSync(path, stored);
        symlinkSync(stored, path);
        expect(() => new LearnerVault(path)).toThrow(/vault is not one exact private file/);
        rmSync(path);
        renameSync(stored, path);
      }

      truncateSync(path, 64 * 1024 * 1024 + 1);
      expect(() => new LearnerVault(path)).toThrow(/vault is not one exact private file/);
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

  it("redacts or refuses learner data under status, rows, score, and grade keys on the egress path", () => {
    const vault = new LearnerVault(":memory:");
    const learnerRoster = new LearnerRoster();
    learnerRoster.register(scope, [{ id: "17", name: "Jane Doe", email: "jane.doe@school.test" }]);
    const token = vault.tokenize(scope, { id: "17", name: "Jane Doe", email: "jane.doe@school.test" });
    const context = { learnerRoster, learnerVault: vault, learnerScope: scope };

    expect(redactLearnerEgress({ grading_status: "Submitted by Jane Doe", rows: ["Jane Doe, 95"], score: "Jane Doe: 95" }, context))
      .toEqual({ grading_status: `Submitted by ${token}`, rows: [`${token}, 95`], score: `${token}: 95` });
    // A bare number under a measure key stays a number, while the same text under a note is a person.
    expect(redactLearnerEgress({ score: "17", page: "17", note: "17" }, context)).toEqual({ score: "17", page: "17", note: token });
    for (const key of ["grading_status", "grade", "score", "rows", "page", "attempt", "workflow_status", "course_id", "operation_id"]) {
      // An address that named nobody on the roster is removed, so what is left
      // names nobody and the reading is returned.
      const removed = redactLearnerEgress({ [key]: "Submitted by unknown.person@school.test" }, context) as Record<string, unknown>;
      expect(String(removed[key]), key).toBe("Submitted by [address removed]");
      // A credential is never returned, whatever surrounds it.
      expect(() => redactLearnerEgress({ [key]: ["Bearer secret-token"] }, context), key).toThrow("privacy_sensitive_text_refused");
    }
    expect(redactLearnerEgress({ note: "Submitted by unknown.person@school.test" }, context))
      .toEqual({ note: "Submitted by [address removed]" });

    // A credential name inside a longer identifier is part of that identifier.
    // Canvas gives every course a random uuid, and one of them reading
    // `99bncSRfVsDh...` refused an entire account audit reading.
    expect(redactLearnerEgress({ uuid: "99bncSRfVsDh50b9zPj57ChlNCeslsiW4od4Q3TG" }, context))
      .toEqual({ uuid: "99bncSRfVsDh50b9zPj57ChlNCeslsiW4od4Q3TG" });
    expect(redactLearnerEgress({ note: "the bearer of this card" }, context))
      .toEqual({ note: "the bearer of this card" });
    // The same names still refuse when they stand on their own.
    expect(() => redactLearnerEgress({ note: "csrf_token=abc123" }, context)).toThrow("privacy_sensitive_text_refused");
    expect(() => redactLearnerEgress({ note: "Bearer secret-token" }, context)).toThrow("privacy_sensitive_text_refused");
  });

  it("reads back a New Quizzes formula question inside a list envelope, and still bounds depth", () => {
    const vault = new LearnerVault(":memory:");
    const learnerRoster = new LearnerRoster();
    learnerRoster.register(scope, [{ id: "17", name: "Jane Doe", email: "jane.doe@school.test" }]);
    const context = { learnerRoster, learnerVault: vault, learnerScope: scope };
    // Canvas's own formula question, eight levels deep inside one item.
    const formula = { entry: { scoring_data: { value: { generated_solutions: [{ inputs: [{ name: "y", value: "2" }], output: "4" }] } } } };
    const read = { structuredContent: { data: { result: { data: [formula] } } } };
    expect(redactLearnerEgress(read, context)).toEqual(read);
    let deep: unknown = "leaf";
    for (let level = 0; level < 40; level += 1) deep = { next: deep };
    expect(() => redactLearnerEgress(deep, context)).toThrow("privacy_output_depth_exceeded");
  });

  it("redacts roster identities under measure keys in projected output too", () => {
    const context = learnerPrivacy();
    const descriptor = { ...learnerDescriptor, allowedFields: ["grading_status", "score"], freeText: "allow" as const };
    const projected = normalize({ structuredContent: { grading_status: "Submitted by Ada Lovelace", score: "95" } }, { ...context, descriptor });
    expect(JSON.stringify(projected)).not.toContain("Ada Lovelace");
    expect(projected.structuredContent).toMatchObject({ score: "95" });
    expect((projected.structuredContent as { grading_status: string }).grading_status).toMatch(/^Submitted by /);
    // An address that named nobody on the roster is removed rather than taking
    // the reading with it, and a credential is still refused outright.
    const removed = normalize({ structuredContent: { grading_status: "unknown.person@school.test" } }, { ...context, descriptor });
    expect(removed.structuredContent).toMatchObject({ grading_status: "[address removed]" });
    const refused = normalize({ structuredContent: { grading_status: "Bearer secret-token" } }, { ...context, descriptor });
    expect(refused.structuredContent).toMatchObject({ code: "privacy_sensitive_text_refused" });
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

  it("reuses one durable vault snapshot for repeated protected learner references", () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-privacy-reference-index-"));
    try {
      const vault = new LearnerVault(join(directory, "vault.json"));
      const learnerRoster = new LearnerRoster();
      const identity = { id: "18", name: "Jane Doe" };
      learnerRoster.register(scope, [identity]);
      const label = vault.tokenize(scope, identity);
      const source = `${label} completed the review. `.repeat(2_000);
      vaultTransactions.count = 0;

      const output = redactKnownLearnerText(source, { learnerRoster, learnerVault: vault, learnerScope: scope });

      expect(output).toBe(source);
      // 2,000 protected references resolve through one durable snapshot, never one transaction each.
      expect(vaultTransactions.count).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 8_000);

  it("refuses an encoded credential, and removes an encoded address, after exact-scope alias redaction", () => {
    const context = learnerPrivacy();
    const descriptor = { ...learnerDescriptor, allowedFields: ["status"], freeText: "allow" as const };
    const credential = normalize({ structuredContent: { status: "Bearer%20secret-value" } }, { ...context, descriptor });
    // The address is written as an HTML entity, and it is found and removed in
    // that form: the match is made on the canonical view and applied to the
    // source bytes.
    const unrostered = normalize({ structuredContent: { status: "outside&#64;example.test" } }, { ...context, descriptor });

    expect(credential.structuredContent).toMatchObject({ code: "privacy_sensitive_text_refused" });
    expect(unrostered.structuredContent).toMatchObject({ status: "[address removed]" });
    expect(JSON.stringify(unrostered)).not.toContain("outside");
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

  it("preserves Moodle course-structure identifiers that collide with learner ids", () => {
    const learnerRoster = new LearnerRoster();
    learnerRoster.register(scope, [
      { id: "3", name: "Section Number Learner" },
      { id: "4", name: "Section Identifier Learner" },
    ]);
    const value = {
      course: { id: "2", sectionlist: ["1", "4", "5"] },
      sections: [
        { id: "4", section: 3, number: 3, cmlist: ["3", "4"], parentsectionid: null },
      ],
      activities: [
        { id: "3", sectionid: "4", sectionnumber: 3 },
      ],
    };

    expect(redactLearnerEgress(value, {
      learnerRoster,
      learnerVault: new LearnerVault(":memory:"),
      learnerScope: scope,
    })).toEqual(value);
  });

  it("preserves Moodle group visibility when its enum value collides with a learner id", () => {
    const learnerRoster = new LearnerRoster();
    learnerRoster.register(scope, [{ id: "3", name: "Visibility Enum Learner" }]);
    const value = {
      course_id: "2",
      groups: [{ id: "1", name: "Study group", visibility: 3, participation: false, membership: [] }],
    };

    expect(redactLearnerEgress(value, {
      learnerRoster,
      learnerVault: new LearnerVault(":memory:"),
      learnerScope: scope,
    })).toEqual(value);
  });

  it("preserves an exact numeric enum option without exempting a learner option", () => {
    const learnerRoster = new LearnerRoster();
    learnerRoster.register(scope, [
      { id: "3", name: "Numeric Option Learner" },
      { id: "4", name: "Jane Learner" },
    ]);
    const result = redactLearnerEgress({
      available: [
        { label: "3", value: "3" },
        { label: "Jane Learner", value: "4" },
      ],
    }, {
      learnerRoster,
      learnerVault: new LearnerVault(":memory:"),
      learnerScope: scope,
    });

    expect(result).toEqual({
      available: [
        { label: "3", value: "3" },
        { label: "Student A2", value: "Student A2" },
      ],
    });
  });

  it("preserves numeric values in a raw available-options array without exempting a learner label", () => {
    const learnerRoster = new LearnerRoster();
    learnerRoster.register(scope, [
      { id: "3", name: "Numeric Option Learner" },
      { id: "4", name: "Jane Learner" },
    ]);

    expect(redactLearnerEgress({
      available_subscription_modes: ["0", "1", "2", "3", "Jane Learner"],
    }, {
      learnerRoster,
      learnerVault: new LearnerVault(":memory:"),
      learnerScope: scope,
    })).toEqual({
      available_subscription_modes: ["0", "1", "2", "3", "Student A2"],
    });
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

  it("preserves an exact Moodle assignment grade definition without treating it as a learner grade record", () => {
    const context = learnerPrivacy();
    const value = { assignment: { id: "16", grade: { type: "point", maximum_points: 100 } } };
    const descriptor = { ...learnerDescriptor, allowedFields: [], fieldPolicy: "scrub-sensitive" as const };

    expect(normalize({ structuredContent: value }, { ...context, descriptor }).structuredContent).toEqual(value);
    expect(redactLearnerEgress(value, {
      learnerRoster: context.learnerRoster!, learnerVault: context.learnerVault!, learnerScope: context.learnerScope!,
    })).toEqual(value);
    expect(() => redactLearnerEgress({ grade: { type: "point", maximum_points: 100, name: "Unknown Person" } }, {
      learnerRoster: context.learnerRoster!, learnerVault: context.learnerVault!, learnerScope: context.learnerScope!,
    })).toThrow("privacy_identity_record_unresolved");
  });

  it("keeps identity-free enrollment details nested under a roster-bound learner", () => {
    const context = learnerPrivacy();
    const value = {
      learners: [{
        id: "17",
        name: "Ada Lovelace",
        email: "ada@example.test",
        enrollments: [{ type: "StudentEnrollment", course_id: "42", enrollment_state: "active" }],
      }],
    };
    const descriptor = { ...learnerDescriptor, allowedFields: [], fieldPolicy: "scrub-sensitive" as const };

    expect(normalize({ structuredContent: value }, { ...context, descriptor }).structuredContent).toMatchObject({
      learners: [{
        learnerToken: expect.stringMatching(/^Student A[1-9][0-9]*/),
        enrollments: [{ type: "StudentEnrollment", course_id: "42", enrollment_state: "active" }],
      }],
    });
    expect(redactLearnerEgress(value, {
      learnerRoster: context.learnerRoster!, learnerVault: context.learnerVault!, learnerScope: context.learnerScope!,
    })).toMatchObject({
      learners: [{
        learnerToken: expect.stringMatching(/^Student A[1-9][0-9]*/),
        enrollments: [{ type: "StudentEnrollment", course_id: "42", enrollment_state: "active" }],
      }],
    });
  });

  it("refuses an unresolved person record nested under a resolved learner", () => {
    const context = learnerPrivacy();
    const value = {
      user: {
        id: "17",
        name: "Ada Lovelace",
        members: [{ name: "Unknown Person", sortable_name: "Person, Unknown" }],
      },
    };
    const descriptor = { ...learnerDescriptor, allowedFields: [], fieldPolicy: "scrub-sensitive" as const };

    const normalized = normalize({ structuredContent: value }, { ...context, descriptor });
    expect(normalized.structuredContent).toMatchObject({ code: "privacy_identity_record_unresolved" });
    expect(JSON.stringify(normalized)).not.toContain("Unknown Person");
    expect(() => redactLearnerEgress(value, {
      learnerRoster: context.learnerRoster!, learnerVault: context.learnerVault!, learnerScope: context.learnerScope!,
    })).toThrow("privacy_identity_record_unresolved");
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

  it("preserves empty identity containers while refusing any unresolved record content", () => {
    const context = learnerPrivacy();
    const learnerContext = {
      learnerRoster: context.learnerRoster!,
      learnerVault: context.learnerVault!,
      learnerScope: context.learnerScope!,
    };
    const normalized = normalize({
      structuredContent: { discussion_topic: { author: {} }, submission: {}, enrollments: [] },
    }, {
      ...context,
      descriptor: { ...learnerDescriptor, allowedFields: [], fieldPolicy: "scrub-sensitive" },
    });
    expect(normalized.structuredContent).toEqual({
      discussion_topic: { author: {} }, submission: {}, enrollments: [],
    });
    expect(redactLearnerEgress({ discussion_topic: { author: {} }, submission: {}, enrollments: [] }, learnerContext)).toEqual({
      discussion_topic: { author: {} }, submission: {}, enrollments: [],
    });
    expect(redactLearnerEgress({ discussion_topic: { author: { role: "teacher" } } }, learnerContext))
      .toEqual({ discussion_topic: { author: { role: "teacher" } } });
    expect(() => redactLearnerEgress({ discussion_topic: { author: { name: "Unknown Person" } } }, learnerContext))
      .toThrow("privacy_identity_record_unresolved");
  });

  it("does not treat structural membership evidence as a person record", () => {
    const context = learnerPrivacy();
    const value = { membership: { read_at: "2026-09-14T22:00:00Z", item_count: 2, item_ids: ["11", "12"], authority: "canvas_list_quiz_items" } };
    const expected = { membership: { read_at: "2026-09-14T22:00:00Z", item_count: 2, item_ids: ["11", "12"], authority: "canvas_list_quiz_items" } };
    expect(normalize({ structuredContent: value }, {
      ...context,
      descriptor: { ...learnerDescriptor, allowedFields: [], fieldPolicy: "scrub-sensitive" },
    }).structuredContent).toEqual(expected);
    expect(redactLearnerEgress(value, {
      learnerRoster: context.learnerRoster!, learnerVault: context.learnerVault!, learnerScope: context.learnerScope!,
    })).toEqual(expected);
  });

  it("scrubs an unrostered course author without refusing ordinary course data", () => {
    const context = learnerPrivacy();
    const result = projectOutput({
      structuredContent: {
        assignment: {
          id: "3918100",
          name: "Course discussion",
          discussion_topic: {
            author: {
              id: "teacher-9",
              display_name: "Professor Example",
              avatar_image_url: "https://canvas.example.test/images/teacher-9.png",
              role: "teacher",
            },
          },
        },
      },
    }, {
      ...context,
      allowUnrosteredCanvasIdentities: true,
      descriptor: {
        ...learnerDescriptor,
        allowedFields: [],
        fieldPolicy: "scrub-sensitive",
        dataClass: "course",
        learnerTokens: false,
      },
    });
    expect(result).toMatchObject({
      structuredContent: {
        assignment: {
          id: "3918100",
          name: "Course discussion",
          discussion_topic: { author: { role: "teacher" } },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("teacher-9");
    expect(JSON.stringify(result)).not.toContain("Professor Example");
  });

  it("scrubs every unrostered Canvas editor identity while preserving resource records", () => {
    const context = learnerPrivacy();
    const canvasContext = {
      ...context,
      allowUnrosteredCanvasIdentities: true,
      descriptor: {
        ...learnerDescriptor,
        allowedFields: [],
        fieldPolicy: "scrub-sensitive" as const,
        dataClass: "course" as const,
        learnerTokens: false,
      },
    };
    const input = {
      structuredContent: {
        page: {
          id: "88",
          title: "Welcome",
          user_id: "teacher-9",
          last_edited_by: { id: "teacher-9", display_name: "Professor Example", role: "teacher" },
        },
        audit: { editor: { id: "admin-2", name: "Admin Example", role: "admin" } },
      },
    };
    const projected = projectOutput(input, canvasContext);
    expect(projected).toMatchObject({
      structuredContent: {
        page: { id: "88", title: "Welcome", last_edited_by: { role: "teacher" } },
        audit: { editor: { role: "admin" } },
      },
    });
    expect(JSON.stringify(projected)).not.toMatch(/teacher-9|Professor Example|admin-2|Admin Example/u);

    const redacted = redactLearnerEgress(input, {
      learnerRoster: context.learnerRoster!, learnerVault: context.learnerVault!, learnerScope: context.learnerScope!,
      allowUnrosteredCanvasIdentities: true,
    });
    expect(redacted).toMatchObject({ structuredContent: projected.structuredContent });
  });

  it("does not classify a resource as a person from user_id alone", () => {
    const context = learnerPrivacy();
    const result = projectOutput({
      structuredContent: { export: { id: "72", user_id: "teacher-9", status: "completed", file_count: 3 } },
    }, {
      ...context,
      allowUnrosteredCanvasIdentities: true,
      descriptor: { ...learnerDescriptor, allowedFields: [], fieldPolicy: "scrub-sensitive", dataClass: "course" },
    });
    expect(result).toMatchObject({ structuredContent: { export: { id: "72", status: "completed", file_count: 3 } } });
    expect(JSON.stringify(result)).not.toContain("teacher-9");
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

  it("scrubs every credential spelling a Canvas external tool record carries", () => {
    const context = learnerPrivacy();
    const descriptor = { ...learnerDescriptor, allowedFields: [], fieldPolicy: "scrub-sensitive" as const, freeText: "allow" as const };
    const value = {
      external_tool: {
        id: "5",
        name: "Proctoring",
        consumer_key: "prod-consumer-91af",
        consumerKey: "prod-consumer-91af",
        session_token: "st_live_44c1",
        sessionToken: "st_live_44c1",
        token: "tk_live_77b0",
        custom_fields: {
          api_key: "ak_live_9d2f81",
          apiKey: "ak_live_9d2f81",
          password: "Sup3rSecret!",
          private_key: "pk_live_31aa",
          privateKey: "pk_live_31aa",
          signature: "abc123signature",
        },
      },
    };
    const leaked = [
      "prod-consumer-91af", "st_live_44c1", "tk_live_77b0", "ak_live_9d2f81",
      "Sup3rSecret!", "pk_live_31aa", "abc123signature",
    ];

    const projected = normalize({ structuredContent: value }, { ...context, descriptor });
    expect(projected.structuredContent).toEqual({ external_tool: { id: "5", name: "Proctoring", custom_fields: {} } });
    const egress = redactLearnerEgress(value, {
      learnerRoster: context.learnerRoster!, learnerVault: context.learnerVault!, learnerScope: context.learnerScope!,
    });
    expect(egress).toEqual({ external_tool: { id: "5", name: "Proctoring", custom_fields: {} } });
    for (const credential of leaked) {
      expect(JSON.stringify(projected), credential).not.toContain(credential);
      expect(JSON.stringify(egress), credential).not.toContain(credential);
    }
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
  it("replaces unique given and family names everywhere and never resolves an ambiguous one", () => {
    const roster = new LearnerRoster();
    roster.register(scope, [{ id: "501", name: "Michaela Adams" }, { id: "502", name: "Alex Smith" }, { id: "503", name: "Alex Jones" }]);
    const ctx = { learnerRoster: roster, learnerScope: scope, learnerVault: new LearnerVault(":memory:") };
    const token = redactKnownLearnerText("Michaela Adams", ctx);
    expect(redactKnownLearnerText("Michaela wrote a message. Adams replied.", ctx)).toBe(`${token} wrote a message. ${token} replied.`);
    expect(redactKnownLearnerText("Alex replied.", ctx)).toBe("[learner] replied.");
    expect(redactLearnerEgress({ outer: [{ body: "Michaela Adams replied to Michaela.", nested: { Michaela: "Alex replied." } }] }, ctx))
      .toEqual({ outer: [{ body: `${token} replied to ${token}.`, nested: { [token]: "[learner] replied." } }] });
    const request = resolveLearnerTokens({ user_id: token, body: `Hello ${token}.`, nested: { [token]: "selected" } }, ctx.learnerVault, scope, roster);
    expect(request).toEqual({ user_id: "501", body: "Hello Michaela Adams.", nested: { "501": "selected" } });
    roster.register(scope, []);
    expect(() => resolveLearnerTokens({ body: `Hello ${token}.` }, ctx.learnerVault, scope, roster)).toThrow("learner_roster_identity_unavailable");
  });
  it("replaces a family name used alone when the roster gives only the full name", () => {
    const roster = new LearnerRoster();
    // A Moodle roster read carries the id, the full name, and the email, never a separate family name.
    roster.register(scope, [
      { id: "601", name: "Michaela Adams", email: "madams@example.edu" },
      { id: "602", name: "Jordan Whitfield" },
      { id: "603", name: "Martin Luther King Jr." },
      { id: "604", name: "Henry Ford II" },
      { id: "605", name: "Okafor, Chidi" },
      { id: "606", name: "Jane Alexandra Doe" },
      { id: "607", name: "Sam Taylor" },
      { id: "608", name: "Taylor Reed" },
      { id: "609", name: "Mary X" },
    ]);
    const ctx = { learnerRoster: roster, learnerScope: scope, learnerVault: new LearnerVault(":memory:") };
    const label = (name: string) => redactKnownLearnerText(name, ctx);
    const [adams, whitfield, king, ford, okafor, doe] = ["Michaela Adams", "Jordan Whitfield", "Martin Luther King Jr.", "Henry Ford II", "Okafor, Chidi", "Jane Alexandra Doe"].map(label);
    expect(new Set([adams, whitfield, king, ford, okafor, doe]).size).toBe(6);
    expect(redactKnownLearnerText("Adams posted. Whitfield replied to Adams.", ctx)).toBe(`${adams} posted. ${whitfield} replied to ${adams}.`);
    expect(redactKnownLearnerText("Ms. Whitfield's essay", ctx)).toBe(`Ms. ${whitfield}'s essay`);
    expect(redactKnownLearnerText("King and Ford presented. Jr. and II stay as written.", ctx)).toBe(`${king} and ${ford} presented. Jr. and II stay as written.`);
    expect(redactKnownLearnerText("Okafor asked Chidi.", ctx)).toBe(`${okafor} asked ${okafor}.`);
    expect(redactKnownLearnerText("Jane Doe and Doe", ctx)).toBe(`${doe} and ${doe}`);
    expect(redactKnownLearnerText("Taylor spoke to Reed. Sam listened.", ctx)).toBe(`[learner] spoke to ${label("Taylor Reed")}. ${label("Sam Taylor")} listened.`);
    expect(redactKnownLearnerText("Mary chose option X.", ctx)).toBe(`${label("Mary X")} chose option X.`);
  });
  it("never replaces a leading title or a family-name particle as a student's name, and never restores one", () => {
    const roster = new LearnerRoster();
    roster.register(scope, [
      { id: "771", name: "Dr. Jane Doe" },
      { id: "772", name: "Ms. Ada Frizzle" },
      { id: "773", name: "Ana van der Berg" },
      { id: "774", name: "Van Nguyen" },
    ]);
    const ctx = { learnerRoster: roster, learnerScope: scope, learnerVault: new LearnerVault(":memory:") };
    const [jane, frizzle, berg, nguyen] = ["Dr. Jane Doe", "Ms. Ada Frizzle", "Ana van der Berg", "Van Nguyen"].map((name) => redactKnownLearnerText(name, ctx));
    expect(new Set([jane, frizzle, berg, nguyen]).size).toBe(4);
    // A title in prose names the course's teacher, and a particle is an ordinary
    // word: neither stands for a rostered student, so the write path never
    // restores a student's name where one stood.
    const teacher = "Dr. Smith will collect the homework. Ms. Brown graded it.";
    expect(redactKnownLearnerText(teacher, ctx)).toBe(teacher);
    expect(redactKnownLearnerText("Van and Der asked a question.", ctx)).toBe("Van and Der asked a question.");
    expect(resolveLearnerTokens({ body: redactKnownLearnerText(teacher, ctx) }, ctx.learnerVault, scope, roster))
      .toEqual({ body: teacher });
    // The student's own names still replace, with or without the title or particle.
    expect(redactKnownLearnerText("Jane Doe and Doe asked. Dr. Jane Doe replied.", ctx)).toBe(`${jane} and ${jane} asked. ${jane} replied.`);
    expect(redactKnownLearnerText("Ada Frizzle and Frizzle asked. Ms. Ada Frizzle replied.", ctx)).toBe(`${frizzle} and ${frizzle} asked. ${frizzle} replied.`);
    expect(redactKnownLearnerText("van der Berg and Berg asked.", ctx)).toBe(`van der ${berg} and ${berg} asked.`);
    expect(redactKnownLearnerText("Nguyen asked, and Van Nguyen too.", ctx)).toBe(`${nguyen} asked, and ${nguyen} too.`);
  });
  it("replaces a lone family name only where it is written with a capital letter", () => {
    const roster = new LearnerRoster();
    roster.register(scope, [
      { id: "701", name: "Jordan Long" },
      { id: "702", name: "Ana Page" },
      { id: "703", name: "Lee Lee" },
      { id: "704", name: "Robin Hall", aliases: ["Hall"] },
      { id: "705", name: "Luca d'Angelo" },
    ]);
    const ctx = { learnerRoster: roster, learnerScope: scope, learnerVault: new LearnerVault(":memory:") };
    const [long, page, lee, hall, angelo] = ["Jordan Long", "Ana Page", "Lee Lee", "Robin Hall", "Luca d'Angelo"].map((name) => redactKnownLearnerText(name, ctx));
    // Written in small letters, a family name is usually an ordinary word, and a label
    // there would come back as the student's full name in text the assistant saves.
    expect(redactKnownLearnerText("Write a long answer on this page.", ctx)).toBe("Write a long answer on this page.");
    expect(redactKnownLearnerText("Long and PAGE replied to d'Angelo.", ctx)).toBe(`${long} and ${page} replied to ${angelo}.`);
    expect(redactKnownLearnerText("jordan long replied.", ctx)).toBe(`${long} replied.`);
    // A family name the roster gives in its own field keeps matching in any case.
    expect(redactKnownLearnerText("Lee met the hall monitor.", ctx)).toBe(`${lee} met the ${hall} monitor.`);
  });
  it("replaces a lone given name only where it is written with a capital letter", () => {
    const roster = new LearnerRoster();
    roster.register(scope, [
      { id: "711", name: "Will Okafor" },
      { id: "712", name: "Grace Hopper" },
      { id: "713", name: "Cher" },
      { id: "714", name: "하늘 민준" },
    ]);
    const ctx = { learnerRoster: roster, learnerScope: scope, learnerVault: new LearnerVault(":memory:") };
    const [will, grace, cher, minjun] = ["Will Okafor", "Grace Hopper", "Cher", "하늘 민준"].map((name) => redactKnownLearnerText(name, ctx));
    // Written in small letters, a given name used alone is usually an ordinary word too, and a
    // label there would come back as the student's full name in text the assistant saves.
    expect(redactKnownLearnerText("You will see the grace period on this page.", ctx)).toBe("You will see the grace period on this page.");
    expect(redactKnownLearnerText("Will and GRACE replied.", ctx)).toBe(`${will} and ${grace} replied.`);
    expect(redactKnownLearnerText("will okafor replied.", ctx)).toBe(`${will} replied.`);
    // A one-word roster name is the whole name, not a part of it, so it matches in any case.
    expect(redactKnownLearnerText("cher replied.", ctx)).toBe(`${cher} replied.`);
    // A script with no capital letters cannot mark a name, so a lone name part in it always matches.
    expect(redactKnownLearnerText("민준 replied. 하늘 agreed.", ctx)).toBe(`${minjun} replied. ${minjun} agreed.`);
  });
  it("replaces a name inside running text of a script that writes no spaces or attaches a particle or prefix to it", () => {
    const roster = new LearnerRoster();
    roster.register(scope, [
      { id: "721", name: "王小明" },
      { id: "722", name: "佐藤 花子" },
      { id: "723", name: "김민준" },
      { id: "724", name: "محمد علي" },
      { id: "725", name: "דוד כהן" },
      { id: "726", name: "สมชาย ใจดี" },
      { id: "727", name: "Ada Lovelace" },
    ]);
    const ctx = { learnerRoster: roster, learnerScope: scope, learnerVault: new LearnerVault(":memory:") };
    const [wang, sato, kim, ali, cohen, somchai, ada] = ["王小明", "佐藤 花子", "김민준", "محمد علي", "דוד כהן", "สมชาย ใจดี", "Ada Lovelace"]
      .map((name) => redactKnownLearnerText(name, ctx));
    expect(new Set([wang, sato, kim, ali, cohen, somchai, ada]).size).toBe(7);
    expect(redactKnownLearnerText("我同意王小明的看法", ctx)).toBe(`我同意${wang}的看法`);
    expect(redactKnownLearnerText("请看王小明的作业。", ctx)).toBe(`请看${wang}的作业。`);
    expect(redactKnownLearnerText("佐藤花子さんの課題を見てください。", ctx)).toBe(`${sato}さんの課題を見てください。`);
    expect(redactKnownLearnerText("花子さんの課題を確認して。", ctx)).toBe(`${sato}さんの課題を確認して。`);
    expect(redactKnownLearnerText("김민준의 과제를 확인해 주세요.", ctx)).toBe(`${kim}의 과제를 확인해 주세요.`);
    expect(redactKnownLearnerText("김 민준 학생", ctx)).toBe(`${kim} 학생`);
    expect(redactKnownLearnerText("أرسل ملاحظة لمحمد علي اليوم.", ctx)).toBe(`أرسل ملاحظة ل${ali} اليوم.`);
    expect(redactKnownLearnerText("שלח הודעה לדוד כהן היום.", ctx)).toBe(`שלח הודעה ל${cohen} היום.`);
    expect(redactKnownLearnerText("ช่วยตรวจงานของสมชายหน่อย", ctx)).toBe(`ช่วยตรวจงานของ${somchai}หน่อย`);
    // A name in a spaced script still ends where a word of an unspaced script begins.
    expect(redactKnownLearnerText("请看Ada Lovelace的作业。", ctx)).toBe(`请看${ada}的作业。`);
    expect(redactKnownLearnerText("Ada의 과제", ctx)).toBe(`${ada}의 과제`);
    // A script that separates words with spaces keeps its word edges.
    expect(redactKnownLearnerText("Please review Ada Lovelace's essay.", ctx)).toBe(`Please review ${ada}'s essay.`);
    expect(redactKnownLearnerText("Adalovelace and Adas stay as written.", ctx)).toBe("Adalovelace and Adas stay as written.");
  });
  it("replaces a name written with a curly apostrophe, another hyphen, a capital dotted I, or without its accents", () => {
    const roster = new LearnerRoster();
    roster.register(scope, [
      { id: "731", name: "Sean O'Brien" },
      { id: "732", name: "Maria D'Angelo" },
      { id: "733", name: "Ana Smith-Jones" },
      { id: "734", name: "İlkay Yıldız" },
      { id: "735", name: "José García" },
      { id: "736", name: "Liam O’Neil" },
    ]);
    const ctx = { learnerRoster: roster, learnerScope: scope, learnerVault: new LearnerVault(":memory:") };
    const [obrien, dangelo, smithJones, ilkay, garcia, oneil] = ["Sean O'Brien", "Maria D'Angelo", "Ana Smith-Jones", "İlkay Yıldız", "José García", "Liam O’Neil"]
      .map((name) => redactKnownLearnerText(name, ctx));
    expect(new Set([obrien, dangelo, smithJones, ilkay, garcia, oneil]).size).toBe(6);
    expect(redactKnownLearnerText("Sean O’Brien submitted the lab.", ctx)).toBe(`${obrien} submitted the lab.`);
    expect(redactKnownLearnerText("Please check O’Brien’s draft.", ctx)).toBe(`Please check ${obrien}’s draft.`);
    expect(redactKnownLearnerText("<p>Sean O&#8217;Brien asked.</p>", ctx)).toBe(`<p>${obrien} asked.</p>`);
    expect(redactKnownLearnerText("Maria DʼAngelo and D＇Angelo and D`Angelo and D´Angelo asked.", ctx))
      .toBe(`${dangelo} and ${dangelo} and ${dangelo} and ${dangelo} asked.`);
    expect(redactKnownLearnerText("Ana Smith‑Jones wrote this. Smith–Jones replied. Smith‐Jones agreed.", ctx))
      .toBe(`${smithJones} wrote this. ${smithJones} replied. ${smithJones} agreed.`);
    expect(redactKnownLearnerText("İlkay Yıldız submitted late. İlkay asked.", ctx)).toBe(`${ilkay} submitted late. ${ilkay} asked.`);
    expect(redactKnownLearnerText("Jose Garcia submitted late. Garcia asked.", ctx)).toBe(`${garcia} submitted late. ${garcia} asked.`);
    expect(redactKnownLearnerText("Liam O'Neil asked.", ctx)).toBe(`${oneil} asked.`);
  });
  it("replaces a name whose letters carry a stroke or are written as two letters, with or without them", () => {
    const roster = new LearnerRoster();
    const names = ["Łukasz Wałęsa", "Søren Kierkegaard", "Đorđe Jovanović", "Ilkay Yıldız", "Đặng Thu Hà", "Guðrún Þórsdóttir", "Lætitia Cœur", "Jürgen Weiß"];
    roster.register(scope, names.map((name, index) => ({ id: String(741 + index), name })));
    const ctx = { learnerRoster: roster, learnerScope: scope, learnerVault: new LearnerVault(":memory:") };
    const [walesa, soren, dorde, yildiz, dang, gudrun, laetitia, weiss] = names.map((name) => redactKnownLearnerText(name, ctx));
    expect(new Set([walesa, soren, dorde, yildiz, dang, gudrun, laetitia, weiss]).size).toBe(8);
    expect(redactKnownLearnerText("Łukasz Wałęsa submitted late.", ctx)).toBe(`${walesa} submitted late.`);
    expect(redactKnownLearnerText("Lukasz Walesa submitted late. Walesa asked.", ctx)).toBe(`${walesa} submitted late. ${walesa} asked.`);
    expect(redactKnownLearnerText("Soren Kierkegaard asked. Soren replied.", ctx)).toBe(`${soren} asked. ${soren} replied.`);
    expect(redactKnownLearnerText("Dorde Jovanovic asked. Dorde replied.", ctx)).toBe(`${dorde} asked. ${dorde} replied.`);
    expect(redactKnownLearnerText("Ilkay Yildiz submitted late. Please ask Yildiz.", ctx)).toBe(`${yildiz} submitted late. Please ask ${yildiz}.`);
    expect(redactKnownLearnerText("Dang Thu Ha asked.", ctx)).toBe(`${dang} asked.`);
    expect(redactKnownLearnerText("Gudrun Thorsdottir asked.", ctx)).toBe(`${gudrun} asked.`);
    expect(redactKnownLearnerText("Laetitia Coeur asked.", ctx)).toBe(`${laetitia} asked.`);
    expect(redactKnownLearnerText("Jurgen Weiss asked. Weiss replied.", ctx)).toBe(`${weiss} asked. ${weiss} replied.`);
    expect(redactKnownLearnerText("<p>S&#248;ren and So&#x308;ren asked.</p>", ctx)).toBe(`<p>${soren} and ${soren} asked.</p>`);
  });
  it("replaces a given or family name used alone from a Chinese, Japanese, or Korean roster name written with no space", () => {
    const roster = new LearnerRoster();
    const names = ["王小明", "김민준", "欧阳小红", "남궁민수", "田中太郎"];
    roster.register(scope, names.map((name, index) => ({ id: String(751 + index), name })));
    const ctx = { learnerRoster: roster, learnerScope: scope, learnerVault: new LearnerVault(":memory:") };
    const [wang, kim, ouyang, namgung, tanaka] = names.map((name) => redactKnownLearnerText(name, ctx));
    expect(new Set([wang, kim, ouyang, namgung, tanaka]).size).toBe(5);
    expect(redactKnownLearnerText("请提醒小明交作业。", ctx)).toBe(`请提醒${wang}交作业。`);
    expect(redactKnownLearnerText("민준에게 과제를 알려 주세요.", ctx)).toBe(`${kim}에게 과제를 알려 주세요.`);
    expect(redactKnownLearnerText("小红交了作业，欧阳也交了。", ctx)).toBe(`${ouyang}交了作业，${ouyang}也交了。`);
    expect(redactKnownLearnerText("민수 학생", ctx)).toBe(`${namgung} 학생`);
    expect(redactKnownLearnerText("太郎さんと田中さん", ctx)).toBe(`${tanaka}さんと${tanaka}さん`);
    // A one-letter family name alone is a common word, such as 王 or 김, and stays as written.
    expect(redactKnownLearnerText("王老师和김 선생님", ctx)).toBe("王老师和김 선생님");
  });
  it("neutralizes a pasted label outside the roster and refuses it only in the strict projection", () => {
    const roster = new LearnerRoster(); roster.register(scope, [{ id: "17", name: "Ada Lovelace" }]);
    const ctx = { learnerRoster: roster, learnerScope: scope, learnerVault: new LearnerVault(":memory:") };
    const stale = "learner_1f0e3dad-9999-4444-8888-99990000abcd";
    expect(redactKnownLearnerText("Great work Student A9! I agree.", ctx)).toBe("Great work [learner]! I agree.");
    expect(redactKnownLearnerText(`See ${stale} for the rest.`, ctx)).toBe("See [learner] for the rest.");
    expect(redactLearnerEgress({ body: "Student A9 replied." }, ctx)).toEqual({ body: "[learner] replied." });
    expect(() => redactLearnerEgress({ body: "Student A9 replied." }, { ...ctx, addresses: "refuse" }))
      .toThrow("learner_roster_identity_unavailable");
  });
  it("replaces numeric identity values without changing typed course IDs or grades", () => {
    const roster = new LearnerRoster(); roster.register(scope, [{ id: "17", name: "Ada Lovelace" }]);
    const ctx = { learnerRoster: roster, learnerScope: scope, learnerVault: new LearnerVault(":memory:") };
    const output = redactLearnerEgress({ references: [17], course_id: 17, course: { id: 17 }, score: 17, user: { id: 17, name: "Ada Lovelace" } }, ctx) as Record<string, unknown>;
    expect(output.references).toEqual([expect.stringMatching(/^Student A[1-9][0-9]*/)]);
    expect(output.course_id).toBe(17); expect(output.course).toEqual({ id: 17 }); expect(output.score).toBe(17);
    expect(() => redactLearnerEgress({ content: [{ type: "image", data: Buffer.from("Ada Lovelace").toString("base64") }] }, ctx)).toThrow("privacy_opaque_artifact_refused");
  });

  it("classifies identities by record meaning instead of an ID collision", () => {
    const roster = new LearnerRoster(); roster.register(scope, [{ id: "17", name: "Ada Lovelace" }]);
    const ctx = { learnerRoster: roster, learnerScope: scope, learnerVault: new LearnerVault(":memory:") };
    expect(redactLearnerEgress({
      assignment: { id: 17, name: "Essay" },
      page: { id: "17", title: "Lesson" },
      target: { kind: "page", id: "17", title: "Lesson" },
      assignment_id: "17",
      quiz_id: "17",
      page_id: "17",
      score: "17",
    }, ctx)).toEqual({
      assignment: { id: 17, name: "Essay" },
      page: { id: "17", title: "Lesson" },
      target: { kind: "page", id: "17", title: "Lesson" },
      assignment_id: "17",
      quiz_id: "17",
      page_id: "17",
      score: "17",
    });
  });

  it("builds one roster index for a large projection", () => {
    class CountingRoster extends LearnerRoster {
      identityReads = 0;
      readyChecks = 0;

      override identities(scopeValue: typeof scope) {
        this.identityReads += 1;
        return super.identities(scopeValue);
      }

      override isReady(scopeValue: typeof scope) {
        this.readyChecks += 1;
        return super.isReady(scopeValue);
      }
    }
    const roster = new CountingRoster();
    const identities = Array.from({ length: 2_500 }, (_, index) => ({
      id: String(index + 1),
      name: `Learner Person ${index + 1}`,
    }));
    roster.register(scope, identities);
    const directory = mkdtempSync(join(tmpdir(), "morrow-privacy-egress-snapshot-"));
    try {
      const vault = new LearnerVault(join(directory, "vault.json"));
      vaultTransactions.count = 0;
      const output = redactLearnerEgress({
        users: identities.map((identity, score) => ({ ...identity, score, comment: "Good work." })),
      }, { learnerRoster: roster, learnerScope: scope, learnerVault: vault }) as {
        users: readonly unknown[];
      };

      expect(output.users).toHaveLength(2_500);
      expect(roster.identityReads).toBe(1);
      expect(roster.readyChecks).toBe(1);
      // 2,500 learners publish through one durable vault transaction, never one per learner.
      expect(vaultTransactions.count).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);

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

describe("learner ids inside links", () => {
  // A link is learner text too: Canvas and Moodle put the person's platform id
  // in grade, submission, and profile links right next to the label Morrow gave.
  const roster = () => {
    const learnerRoster = new LearnerRoster();
    learnerRoster.register(scope, [
      { id: "98765", name: "Jane Doe", email: "jane.doe@school.test" },
      { id: "55123", name: "Robert Smith" },
      { id: "17", name: "Mia Chen" },
      { id: "_4411_1", name: "Omar Haddad" },
    ]);
    return { learnerRoster, learnerVault: new LearnerVault(":memory:"), learnerScope: scope };
  };

  it("replaces a learner id in Canvas grade and submission links next to the label", () => {
    const context = roster();
    const output = JSON.stringify(redactLearnerEgress([
      { id: 98765, name: "Jane Doe", enrollments: [{ user_id: 98765, grades: { html_url: "https://school.instructure.com/courses/1/grades/98765", final_grade: "F" } }] },
      { user_id: 55123, preview_url: "https://school.instructure.com/courses/1/assignments/3/submissions/55123?preview=1&version=2", html_url: "https://school.instructure.com/courses/1/assignments/3/submissions/55123" },
      { note: "Open /courses/1/gradebook/speed_grader?assignment_id=3&student_id=98765 or /courses/1/users/98765/usage" },
    ], context));
    expect(output).not.toMatch(/98765|55123/u);
    expect(output).toContain("/courses/1/grades/Student A1");
    expect(output).toContain("/courses/1/assignments/3/submissions/Student A2?preview=1&version=2");
    expect(output).toContain("speed_grader?assignment_id=3&student_id=Student A1");
  });

  it("replaces a learner id in Moodle profile, grade report, and activity links", () => {
    const context = roster();
    const links = [
      ["https://moodle.school.test/user/view.php?id=17&course=42", "https://moodle.school.test/user/view.php?id=Student A3&course=42"],
      ["https://moodle.school.test/user/profile.php?id=17", "https://moodle.school.test/user/profile.php?id=Student A3"],
      ["https://moodle.school.test/user/view.php?course=42&id=17", "https://moodle.school.test/user/view.php?course=42&id=Student A3"],
      ["https://moodle.school.test/grade/report/user/index.php?id=42&userid=17", "https://moodle.school.test/grade/report/user/index.php?id=42&userid=Student A3"],
      ["https://moodle.school.test/mod/assign/view.php?id=17&action=grader&userid=17", "https://moodle.school.test/mod/assign/view.php?id=17&action=grader&userid=Student A3"],
      ["https://moodle.school.test/mod/forum/user.php?id=17&course=42", "https://moodle.school.test/mod/forum/user.php?id=Student A3&course=42"],
      ["<a href=\"https://moodle.school.test/report/log/index.php?chooselog=1&amp;user=17&amp;id=42\">log</a>", "<a href=\"https://moodle.school.test/report/log/index.php?chooselog=1&amp;user=Student A3&amp;id=42\">log</a>"],
    ];
    for (const [source, expected] of links) expect(redactKnownLearnerText(source!, context)).toBe(expected);
  });

  it("replaces a Blackboard learner id in a REST link", () => {
    const context = roster();
    expect(redactKnownLearnerText("/learn/api/public/v1/courses/_42_1/users/_4411_1?fields=id", context))
      .toBe("/learn/api/public/v1/courses/_42_1/users/Student A4?fields=id");
  });

  it("finds a learner id inside an encoded return link", () => {
    const context = roster();
    expect(redactKnownLearnerText("/login?return_to=%2Fcourses%2F1%2Fgrades%2F98765", context))
      .toBe("/login?return_to=%2Fcourses%2F1%2Fgrades%2FStudent A1");
  });

  it("replaces a long learner id written bare in prose, but not an object id or a short number", () => {
    const context = roster();
    expect(redactKnownLearnerText("grades for 98765 and 55123 posted", context)).toBe("grades for Student A1 and Student A2 posted");
    for (const text of ["course 98765 opens Monday", "assignment 55123 is due", "17 of 20 points", "see /courses/98765/pages"]) {
      expect(redactKnownLearnerText(text, context)).toBe(text);
    }
    expect(redactLearnerEgress({ course_id: "98765", note: "for 98765" }, context)).toEqual({ course_id: "98765", note: "for Student A1" });
  });

  it("keeps course, activity, file, and page ids that equal a learner id", () => {
    const context = roster();
    for (const link of [
      "https://school.instructure.com/courses/17/assignments/17",
      "https://school.instructure.com/courses/17/files/17/download?verifier=abc",
      "https://school.instructure.com/courses/17/discussion_topics/17?page=17",
      "https://moodle.school.test/course/view.php?id=17",
      "https://moodle.school.test/mod/forum/discuss.php?d=17&parent=17",
      "https://moodle.school.test/pluginfile.php/17/mod_forum/attachment/17/notes.pdf",
      "https://moodle.school.test/course/modedit.php?update=17&return=1",
    ]) expect(redactKnownLearnerText(link, context)).toBe(link);
  });
});

// A Canvas HTML body, an HTML file Morrow reads, or text pasted from Word can
// carry a name as named character references or with invisible format
// characters. The match view decodes every named reference and drops those
// characters, so the name is replaced exactly as its raw spelling is.
describe("learner names written as references and with invisible characters", () => {
  const identities = [
    { id: "701", name: "José García" },
    { id: "702", name: "François Müller" },
    { id: "703", name: "Ada Lovelace" },
  ];
  const context = () => {
    const learnerRoster = new LearnerRoster();
    learnerRoster.register(scope, identities);
    return { learnerRoster, learnerVault: new LearnerVault(":memory:"), learnerScope: scope };
  };

  it("decodes named character references for accented letters", () => {
    expect(redactKnownLearnerText("<p>Great work, Jos&eacute; Garc&iacute;a!</p>", context()))
      .toBe("<p>Great work, Student A1!</p>");
    expect(redactKnownLearnerText("<p>Fran&ccedil;ois M&uuml;ller presented.</p>", context()))
      .toBe("<p>Student A2 presented.</p>");
  });

  it("keeps replacing raw UTF-8 and numeric references the way it did", () => {
    expect(redactKnownLearnerText("<p>Great work, José García!</p>", context()))
      .toBe("<p>Great work, Student A1!</p>");
    expect(redactKnownLearnerText("<p>Great work, Jos&#233; Garc&#237;a!</p>", context()))
      .toBe("<p>Great work, Student A1!</p>");
  });

  it("drops invisible format characters from the match view on the text side", () => {
    for (const [text, expected] of [
      ["Ada Love\u00adlace presented.", "Student A3 presented."],
      ["<p>Ada Love&shy;lace presented.</p>", "<p>Student A3 presented.</p>"],
      ["Ada Love\u200blace presented.", "Student A3 presented."],
      ["Ada Love\u2060lace presented.", "Student A3 presented."],
    ] as const) {
      expect(redactKnownLearnerText(text, context())).toBe(expected);
    }
  });

  it("drops invisible format characters from the roster side too", () => {
    const learnerRoster = new LearnerRoster();
    learnerRoster.register(scope, [{ id: "704", name: "Grace\u200bHopper" }]);
    const context = { learnerRoster, learnerVault: new LearnerVault(":memory:"), learnerScope: scope };
    expect(redactKnownLearnerText("Grace Hopper submitted late.", context)).toBe("Student A1 submitted late.");
  });
});

// A student with two family names, as most Spanish- and Portuguese-speaking
// students have, is referred to by either surname alone. The roster's own
// family-name fields and, where it gives none, every word after the given name
// name that student on their own.
describe("compound family names", () => {
  const identities = [
    { id: "601", name: "José García López", aliases: ["García López, José"] },
    { id: "603", name: "Ada Lovelace" },
  ];
  const context = () => {
    const learnerRoster = new LearnerRoster();
    learnerRoster.register(scope, identities);
    return { learnerRoster, learnerVault: new LearnerVault(":memory:"), learnerScope: scope };
  };

  it("replaces each surname alone and both surnames without the given name", () => {
    expect(redactKnownLearnerText("García submitted late.", context())).toBe("Student A1 submitted late.");
    expect(redactLearnerEgress({ note: "García López submitted late." }, context()))
      .toEqual({ note: "Student A1 submitted late." });
    expect(redactKnownLearnerText("Hablé con el Sr. García ayer.", context()))
      .toBe("Hablé con el Sr. Student A1 ayer.");
  });

  it("keeps replacing the given name, the last family word, and the whole name", () => {
    expect(redactKnownLearnerText("Please remind José to submit.", context())).toBe("Please remind Student A1 to submit.");
    expect(redactKnownLearnerText("López submitted late.", context())).toBe("Student A1 submitted late.");
    expect(redactKnownLearnerText("José García López submitted late.", context())).toBe("Student A1 submitted late.");
  });

  it("replaces a middle name used alone when the roster names no family part", () => {
    const learnerRoster = new LearnerRoster();
    learnerRoster.register(scope, [{ id: "605", name: "Ada Grace Lovelace" }]);
    const context = { learnerRoster, learnerVault: new LearnerVault(":memory:"), learnerScope: scope };
    expect(redactKnownLearnerText("Grace submitted late.", context)).toBe("Student A1 submitted late.");
  });
});

// Canvas builds page addresses from titles and teachers name files with the
// student's full name joined by hyphens, underscores, or dots. The match view
// treats those spellings as the same name, and a page addressed by its
// redacted address still resolves when it comes back.
describe("full names joined without spaces", () => {
  const identities = [{ id: "703", name: "Ada Lovelace" }];
  const context = () => {
    const learnerRoster = new LearnerRoster();
    learnerRoster.register(scope, identities);
    return { learnerRoster, learnerVault: new LearnerVault(":memory:"), learnerScope: scope };
  };

  it("replaces the name joined by hyphens, underscores, and dots", () => {
    expect(redactKnownLearnerText("ada-lovelace-reflection", context())).toBe("Student A1-reflection");
    expect(redactLearnerEgress({ filename: "Lovelace_Ada_feedback.docx" }, context()))
      .toEqual({ filename: "Student A1_feedback.docx" });
    expect(redactKnownLearnerText("pages/ada.lovelace.notes", context())).toBe("pages/Student A1.notes");
  });

  it("keeps matching the spaced spellings and the reversed order", () => {
    expect(redactKnownLearnerText("Lovelace Ada submitted late.", context())).toBe("Student A1 submitted late.");
    expect(redactKnownLearnerText("Ada Lovelace submitted late.", context())).toBe("Student A1 submitted late.");
  });

  it("restores a page address the assistant sends back so it still resolves", () => {
    const vault = new LearnerVault(":memory:");
    const learnerRoster = new LearnerRoster();
    learnerRoster.register(scope, identities);
    const context = { learnerRoster, learnerVault: vault, learnerScope: scope };
    expect(redactKnownLearnerText("Ada Lovelace submitted late.", context)).toBe("Student A1 submitted late.");
    const resolved = resolveLearnerTokens(
      { url_or_id: "https://canvas.example.test/courses/42/pages/Student A1-reflection" },
      vault,
      scope,
    );
    expect(resolved).toEqual({ url_or_id: "https://canvas.example.test/courses/42/pages/ada-lovelace-reflection" });
  });
});
