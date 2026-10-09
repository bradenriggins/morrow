import { REVIEW_OPEN_NONCE, reviewApprovalProof, type LoopbackApprovalServer } from "../../src/approval-server.js";

/**
 * The `presence` value Morrow Bridge adds to an approval form after a person's own click. Tests
 * that stand in for that person sign with the server's in-process key; an HTTP client has no key.
 */
export function bridgeSignedPresence(server: LoopbackApprovalServer, approveUrl: string, nonce: string): string {
  const presence = server.approvalPresence;
  if (!presence) throw new Error("the approval server has not started");
  return reviewApprovalProof(presence.key, new URL(approveUrl).pathname, nonce);
}

/** Headers Morrow Bridge sends when it opens a review page. Accept and User-Agent are not a proof. */
export function reviewDocumentHeaders(server: LoopbackApprovalServer, pageUrl: string): Record<string, string> {
  const presence = server.approvalPresence;
  if (!presence) throw new Error("the approval server has not started");
  const pagePath = new URL(pageUrl, "http://127.0.0.1").pathname.replace(/\/status$/u, "");
  return {
    accept: "text/html",
    "user-agent": "Mozilla/5.0",
    "x-morrow-review-presence": reviewApprovalProof(presence.key, pagePath, REVIEW_OPEN_NONCE),
  };
}
