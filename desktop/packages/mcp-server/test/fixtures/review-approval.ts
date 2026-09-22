import { reviewApprovalProof, type LoopbackApprovalServer } from "../../src/approval-server.js";

/**
 * The `presence` value Morrow Bridge adds to an approval form after a person's own click. Tests
 * that stand in for that person sign with the server's in-process key; an HTTP client has no key.
 */
export function bridgeSignedPresence(server: LoopbackApprovalServer, approveUrl: string, nonce: string): string {
  const presence = server.approvalPresence;
  if (!presence) throw new Error("the approval server has not started");
  return reviewApprovalProof(presence.key, new URL(approveUrl).pathname, nonce);
}
