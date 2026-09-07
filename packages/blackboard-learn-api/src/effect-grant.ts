import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "@morrow/contracts";

export interface BlackboardEffectGrant {
  readonly schema: "morrow.blackboard.effect-grant.v1";
  readonly operationId: string;
  /** Exact Blackboard source plan digest, checked before any provider read or PATCH. */
  readonly planDigest: string;
  /** Durable outer Morrow operation plan digest, retained inside the signed grant. */
  readonly outerPlanDigest: string;
  readonly approvalGrantDigest: string;
  readonly effectReceiptId: string;
  readonly dispatchAttempt: number;
  readonly gatewayProcessId: string;
  readonly dispatchToken: string;
}

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
  });
}

export function signBlackboardEffectGrant(secret: string, value: UnsignedGrant): string {
  return createHmac("sha256", Buffer.from(secret, "base64url")).update(unsigned(value), "utf8").digest("hex");
}

export function blackboardEffectGrantAccepted(secret: string | undefined, value: unknown): value is BlackboardEffectGrant {
  if (!secret || typeof value !== "object" || value === null) return false;
  const grant = value as Partial<BlackboardEffectGrant>;
  if (grant.schema !== "morrow.blackboard.effect-grant.v1"
    || typeof grant.operationId !== "string" || !/^op:[A-Za-z0-9_-]{1,160}$/.test(grant.operationId)
    || typeof grant.planDigest !== "string" || !/^[0-9a-f]{64}$/.test(grant.planDigest)
    || typeof grant.outerPlanDigest !== "string" || !/^[0-9a-f]{64}$/.test(grant.outerPlanDigest)
    || typeof grant.approvalGrantDigest !== "string" || !/^[0-9a-f]{64}$/.test(grant.approvalGrantDigest)
    || typeof grant.effectReceiptId !== "string" || !/^effect:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(grant.effectReceiptId)
    || typeof grant.dispatchAttempt !== "number" || !Number.isInteger(grant.dispatchAttempt) || grant.dispatchAttempt < 1
    || typeof grant.gatewayProcessId !== "string" || !/^[A-Za-z0-9:_-]{8,300}$/.test(grant.gatewayProcessId)
    || typeof grant.dispatchToken !== "string" || !/^[0-9a-f]{64}$/.test(grant.dispatchToken)) return false;
  const expected = signBlackboardEffectGrant(secret, grant as UnsignedGrant);
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(grant.dispatchToken, "hex"));
}
