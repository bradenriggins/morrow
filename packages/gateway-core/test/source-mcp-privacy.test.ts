import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canvasPrivacyRoster, moodleSourceHistoryAvailable, SourceMcpPrivacyBoundary, INTERNAL_SOURCE_CAPABILITY_META, sourcePrivacyInputSchema, sourcePrivacyRoster } from "../src/source-mcp-privacy.js";

const binding = { sourceBindingId: "binding-42", provider: "canvas", courseId: "42", origin: "https://canvas.example.edu",
  runtimeVerified: true, principalFingerprint: "b".repeat(64), sessionGeneration: 1, catalogDigest: "c".repeat(64) };
const learners = sourcePrivacyRoster([{ id: 912345, name: "Mary Jackson", email: "mary@example.edu", login_id: "mjackson", sis_user_id: "SIS-987654", short_name: "MJ", sortable_name: "Jackson, Mary", aliases: ["Mary J."] }]);
const request = { course_id: 42, _morrow: { source_binding_id: binding.sourceBindingId } };
const envelope = (value: unknown) => ({ content: [{ type: "text", text: "Read complete." }], structuredContent: { ok: true, value } });
const setup = (options: Record<string, unknown> = {}) => new SourceMcpPrivacyBoundary({ source: "test", bindings: () => [binding], loadRoster: async () => learners, ...options });
const text = (value: unknown) => JSON.stringify(value);

describe("source MCP privacy boundary", () => {
  it("uses the complete roster on all strings, nested records, keys, errors and numeric identifiers", async () => {
    const result = await setup().invoke("canvas_read", request, undefined, async () => envelope({
      cache: { "mary@example.edu": "MJ, please ask Mary J. and mjackson. SIS-987654" },
      comments: ["Mary Jackson posted. Mary answered. Jackson, Mary."],
      custom: 912345,
      problem: { message: "Mary Jackson at mary@example.edu" },
    }));
    expect(result.isError).not.toBe(true);
    for (const value of ["Mary", "Jackson", "mary@example.edu", "mjackson", "SIS-987654", "912345", "MJ"]) expect(text(result)).not.toContain(value);
    expect(text(result)).toContain("Student A");
  });

  it("resolves course-local pseudonyms in write text and recipient identifiers, without exposing raw readback", async () => {
    const boundary = setup();
    const read = await boundary.invoke("canvas_read", request, undefined, async () => envelope("Mary Jackson"));
    const token = text(read).match(/Student A[1-9][0-9]*/u)![0];
    const write = vi.fn(async (args) => envelope(args));
    const response = await boundary.invoke("canvas_write", { ...request, user_id: token, recipients: [token], body: `Hello ${token}` }, undefined, write);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ user_id: "912345", recipients: ["912345"], body: "Hello Mary Jackson" }));
    expect(text(response)).not.toContain("Mary");
    expect(text(response)).not.toContain("912345");
    expect(text(response)).toContain(token);
  });

  it.each([
    { successful: [{ user_id: "912345", extra_time: 15 }], failed: [] },
    { successful: [], failed: [{ user_id: "912345", message: "Mary Jackson cannot receive this accommodation." }] },
  ])("redacts New Quiz accommodation success and failure rows %#", async (providerResult) => {
    const boundary = setup();
    const labelRead = await boundary.invoke("canvas_read", request, undefined, async () => envelope("Mary Jackson"));
    const token = text(labelRead).match(/Student A[1-9][0-9]*/u)![0];
    const response = await boundary.invoke("canvas_set_quiz_level_accommodations", {
      ...request, user_id: token, extra_time: 15,
    }, undefined, async (resolved) => {
      expect(resolved.user_id).toBe("912345");
      return envelope(providerResult);
    });
    expect(response.isError).not.toBe(true);
    expect(text(response)).toContain(token);
    for (const value of ["912345", "Mary", "Jackson"]) expect(text(response)).not.toContain(value);
  });

  it("preserves pseudonyms across complete roster refreshes and refuses cross-course use", async () => {
    const second = { ...binding, sourceBindingId: "binding-43", courseId: "43" };
    const boundary = setup({ bindings: () => [binding, second] });
    const read = () => boundary.invoke("canvas_read", request, undefined, async () => envelope("Mary Jackson"));
    const first = await read();
    expect(await read()).toEqual(first);
    const token = text(first).match(/Student A[1-9][0-9]*/u)![0];
    const write = vi.fn();
    expect((await boundary.invoke("canvas_write", { course_id: 43, _morrow: { source_binding_id: second.sourceBindingId }, body: token }, undefined, write)).isError).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses ambiguous name fragments, incomplete rosters, changed bindings, and unknown donor aliases", async () => {
    const ambiguous = setup({ loadRoster: async () => [...learners, { id: "991199", name: "Mary Johnson" }] });
    expect((await ambiguous.invoke("canvas_read", request, undefined, async () => envelope("Mary replied"))).isError).toBe(true);
    const denied = setup({ loadRoster: async () => { throw new Error("Mary Jackson roster incomplete"); } });
    const handler = vi.fn();
    expect((await denied.invoke("canvas_write", request, undefined, handler)).isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    let current = binding;
    const changing = setup({ bindings: () => [current] });
    expect((await changing.invoke("canvas_read", request, undefined, async () => { current = { ...binding, sessionGeneration: 2 }; return envelope("Mary Jackson"); })).isError).toBe(true);
    expect((await setup().invoke("legacy_read", request, undefined, async () => envelope("Student_deadbeef"))).isError).toBe(true);
  });

  it("has no argument-selected raw mode; missing or wrong capability uses safe behavior", async () => {
    const secret = "a".repeat(64);
    const handler = vi.fn(async () => envelope("Mary Jackson"));
    const boundary = setup({ internalSourceCapability: secret });
    for (const extra of [{ raw: true }, { internalSourceCapability: secret }, { _meta: { [INTERNAL_SOURCE_CAPABILITY_META]: secret } }]) {
      const result = await boundary.invoke("canvas_read", { ...request, ...extra }, undefined, handler);
      expect(text(result)).not.toContain("Mary");
      expect(text(result)).not.toContain(secret);
    }
    expect((await boundary.invoke("canvas_read", request, { [INTERNAL_SOURCE_CAPABILITY_META]: "b".repeat(64) }, handler)).isError).toBe(true);
    expect((await setup().invoke("canvas_read", request, { [INTERNAL_SOURCE_CAPABILITY_META]: secret }, handler)).isError).toBe(true);
    const raw = await boundary.invoke("canvas_read", {}, { [INTERNAL_SOURCE_CAPABILITY_META]: secret }, handler);
    expect(text(raw)).toContain("Mary Jackson");
    expect(text(raw)).not.toContain(secret);
  });

  it("refuses unscoped calls, private payloads, unsafe exceptions and malformed aliases", async () => {
    const boundary = setup();
    const handler = vi.fn(async () => { throw new Error("Mary Jackson raw failure"); });
    expect((await boundary.invoke("canvas_read", {}, undefined, handler)).isError).toBe(true);
    expect((await boundary.invoke("canvas_send_private_conversation", request, undefined, handler)).isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    const result = await boundary.invoke("canvas_read", request, undefined, handler);
    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain("Mary");
    expect(() => sourcePrivacyRoster([{ id: "1", aliases: [17] }])).toThrow();
  });

  it("persists course labels across source restarts without plaintext roster storage", async () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-source-privacy-"));
    try {
      const path = join(directory, "vault.json");
      const first = await setup({ learnerVaultPath: path }).invoke("canvas_read", request, undefined, async () => envelope("Mary Jackson"));
      const restarted = setup({ learnerVaultPath: path });
      expect(await restarted.invoke("canvas_read", request, undefined, async () => envelope("Mary Jackson"))).toEqual(first);
      expect(readFileSync(path, "utf8")).not.toContain("Mary Jackson");
      const label = text(first).match(/Student A[1-9][0-9]*/u)![0];
      const write = vi.fn(async (args) => envelope(args));
      await restarted.invoke("canvas_write", { ...request, user_id: label }, undefined, write);
      expect(write).toHaveBeenCalledWith(expect.objectContaining({ user_id: "912345" }));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("extends learner ID input positions without changing structural course ID types", () => {
    const input = sourcePrivacyInputSchema({ type: "object", properties: { user_id: { type: "integer" }, course_id: { type: "integer" }, recipients: { type: "array", items: { type: "integer" } } } });
    expect(input.properties).toMatchObject({ user_id: { anyOf: expect.any(Array) }, course_id: { type: "integer" } });
    expect(text(input)).not.toContain(INTERNAL_SOURCE_CAPABILITY_META);
  });
});


describe("historical roster identity dictionary", () => {
  const former = { id: "818181", name: "Alice Former", short_name: "Ali", email: "alice@example.edu", login_id: "aformer" };
  const enrollment = { course_id: "42", type: "StudentEnrollment", enrollment_state: "deleted", user_id: former.id, sis_user_id: "SIS-818181", user: former };

  it("deduplicates multiple deleted enrollments and removes historical aliases from all egress", async () => {
    const roster = canvasPrivacyRoster([], [enrollment, enrollment], "42");
    expect(roster).toHaveLength(1);
    const boundary = setup({ loadRoster: async () => roster });
    const projected = await boundary.invoke("canvas_read", request, undefined, async () => envelope({
      posts: ["Alice Former was unenrolled. Ali sent alice@example.edu and aformer"], cache: { "SIS-818181": former.id },
    }));
    expect(projected.isError).not.toBe(true);
    expect(text(projected)).toContain("Student A1");
    for (const name of ["Alice", "Former", "Ali", "alice@example.edu", "aformer", "818181"]) expect(text(projected)).not.toContain(name);
    const write = vi.fn(async (args) => envelope(args));
    await boundary.invoke("canvas_write", { ...request, user_id: "Student A1" }, undefined, write);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ user_id: former.id }));
  });

  it("merges current and deleted student records without changing the same student's label", () => {
    const roster = canvasPrivacyRoster([former], [enrollment, { ...enrollment, user: { ...former, aliases: ["Alice F."] } }], "42");
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ id: former.id, sisUserId: "SIS-818181" });
    expect(roster[0]!.aliases).toContain("Alice F.");
  });

  it.each([
    { course_id: "43" }, { type: "TeacherEnrollment" }, { enrollment_state: "active" }, { user_id: "999" }, { user: null },
    { user: { id: former.id } },
  ])("refuses mismatched or incomplete deleted-user evidence %j", (change) => {
    expect(() => canvasPrivacyRoster([], [{ ...enrollment, ...change }], "42")).toThrow();
  });

  it("refuses conflicting identities for the same learner ID", () => {
    expect(() => canvasPrivacyRoster([{ ...former, name: "Different Learner" }], [enrollment], "42")).toThrow("privacy_roster_history_conflict");
  });

  it("does not send a content read when the historical dictionary is unavailable", async () => {
    const handler = vi.fn(async () => envelope("Alice Former posted this"));
    const boundary = setup({ loadRoster: async () => { throw new Error("privacy_roster_history_incomplete"); } });
    expect((await boundary.invoke("canvas_read", request, undefined, handler)).isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it("holds Moodle former-user content while keeping current roster and course-authored design reads", () => {
    expect(moodleSourceHistoryAvailable("moodle_get_forum_posts", "learner")).toBe(false);
    expect(moodleSourceHistoryAvailable("moodle_get_assignment_submission", "learner")).toBe(false);
    expect(moodleSourceHistoryAvailable("moodle_get_course_log_summary", "learner")).toBe(false);
    expect(moodleSourceHistoryAvailable("moodle_get_wiki_page", "course")).toBe(false);
    expect(moodleSourceHistoryAvailable("moodle_get_page", "course")).toBe(true);
    expect(moodleSourceHistoryAvailable("moodle_get_course_participant_roster", "learner")).toBe(true);
  });
});
