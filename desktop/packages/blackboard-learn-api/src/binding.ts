import { createHash } from "node:crypto";
import { canonicalJson } from "@morrow/contracts";
import { BLACKBOARD_ID, BLACKBOARD_SOURCE_BINDING_ID } from "./types.js";

/** A binding cannot be configured independently of the exact tenant principal and course. */
export function deriveBlackboardSourceBindingId(baseUrl: string, principalId: string, courseId: string): string {
  const origin = new URL(baseUrl).origin;
  if (!BLACKBOARD_ID.test(principalId) || !BLACKBOARD_ID.test(courseId)) throw new TypeError("Blackboard binding identity is invalid");
  const digest = createHash("sha256").update(canonicalJson({ provider: "blackboard", origin, principalId, courseId }), "utf8").digest("hex");
  const binding = `blackboard:${digest}`;
  if (!BLACKBOARD_SOURCE_BINDING_ID.test(binding)) throw new TypeError("Blackboard binding id is invalid");
  return binding;
}
