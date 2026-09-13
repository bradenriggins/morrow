import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "@morrow/contracts";

export interface BlackboardEffectGrant {
  readonly schema: "morrow.blackboard.effect-grant.v2";
  readonly operationId: string;
  /** Exact Blackboard source plan digest, checked before any provider read or PATCH. */
  readonly planDigest: string;
  /** Durable outer Morrow operation plan digest, retained inside the signed grant. */
  readonly outerPlanDigest: string;
  readonly approvalGrantDigest: string;
  readonly effectReceiptId: string;
  readonly dispatchAttempt: number;
  readonly gatewayProcessId: string;
  /** Epoch milliseconds at which the Gateway minted this single-dispatch grant. */
  readonly issuedAt: number;
  /** Exclusive epoch-millisecond deadline after which the grant is invalid. */
  readonly notAfter: number;
  readonly dispatchToken: string;
}

/** A grant exists only to cross the local Gateway-to-source dispatch boundary. */
export const BLACKBOARD_EFFECT_GRANT_MAX_LIFETIME_MS = 5 * 60 * 1_000;

type UnsignedGrant = Omit<BlackboardEffectGrant, "dispatchToken">;

function unsigned(value: UnsignedGrant): string {
  return canonicalJson({
    schema: value.schema,
    operationId: value.operationId,
    planDigest: value.planDigest,
    outerPlanDigest: value.outerPlanDigest,
    approvalGrantDigest: value.approvalGrantDigest,
    effectReceiptId: value.effectReceiptId,
    dispatchAttempt: value.dispatchAttempt,
    gatewayProcessId: value.gatewayProcessId,
    issuedAt: value.issuedAt,
    notAfter: value.notAfter,
  });
}

export function signBlackboardEffectGrant(secret: string, value: UnsignedGrant): string {
  return createHmac("sha256", Buffer.from(secret, "base64url")).update(unsigned(value), "utf8").digest("hex");
}

export function blackboardEffectGrantAccepted(secret: string | undefined, value: unknown, now = Date.now()): value is BlackboardEffectGrant {
  if (!secret || typeof value !== "object" || value === null) return false;
  const grant = value as Partial<BlackboardEffectGrant>;
  if (grant.schema !== "morrow.blackboard.effect-grant.v2"
    || typeof grant.operationId !== "string" || !/^op:[A-Za-z0-9_-]{1,160}$/.test(grant.operationId)
    || typeof grant.planDigest !== "string" || !/^[0-9a-f]{64}$/.test(grant.planDigest)
    || typeof grant.outerPlanDigest !== "string" || !/^[0-9a-f]{64}$/.test(grant.outerPlanDigest)
    || typeof grant.approvalGrantDigest !== "string" || !/^[0-9a-f]{64}$/.test(grant.approvalGrantDigest)
    || typeof grant.effectReceiptId !== "string" || !/^effect:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(grant.effectReceiptId)
    || typeof grant.dispatchAttempt !== "number" || !Number.isInteger(grant.dispatchAttempt) || grant.dispatchAttempt < 1
    || typeof grant.gatewayProcessId !== "string" || !/^[A-Za-z0-9:_-]{8,300}$/.test(grant.gatewayProcessId)
    || typeof grant.issuedAt !== "number" || !Number.isSafeInteger(grant.issuedAt) || grant.issuedAt < 0
    || typeof grant.notAfter !== "number" || !Number.isSafeInteger(grant.notAfter)
    || grant.notAfter <= grant.issuedAt || grant.notAfter - grant.issuedAt > BLACKBOARD_EFFECT_GRANT_MAX_LIFETIME_MS
    || !Number.isSafeInteger(now) || now < grant.issuedAt || now >= grant.notAfter
    || typeof grant.dispatchToken !== "string" || !/^[0-9a-f]{64}$/.test(grant.dispatchToken)) return false;
  const expected = signBlackboardEffectGrant(secret, grant as UnsignedGrant);
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(grant.dispatchToken, "hex"));
}
