import { describe, expect, it } from "vitest";
import { canvasConversationInputSchema, canvasConversationPlan } from "../src/canvas-conversations.js";

const request = { action: "create", source_binding_id: "canvas:course:41", course_id: 41, recipient_tokens: ["Student A1", "Student A2"], body: "Hello Student A1." };

describe("Canvas conversation learner labels", () => {
  it("preserves readable recipients and message labels in the reviewed plan", () => {
    const input = canvasConversationInputSchema.parse(request);
    expect(canvasConversationPlan(input)).toMatchObject({ recipient_tokens: ["Student A1", "Student A2"], body: "Hello Student A1." });
    expect(canvasConversationInputSchema.safeParse({ ...request, action: "reply", conversation_id: "12" }).success).toBe(true);
  });

  it("refuses duplicate, ambiguous, raw, and internal-only recipient references", () => {
    for (const recipients of [["Student A1", "Student A1"], ["Student A1 or Student A2"], ["Student A01"], ["41"], ["learner_2f1a5b3c-9d4e-4f6a-8b7c-1d2e3f4a5b6c"]]) {
      expect(canvasConversationInputSchema.safeParse({ ...request, recipient_tokens: recipients }).success, JSON.stringify(recipients)).toBe(false);
    }
  });
});
