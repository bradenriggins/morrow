import {
  isJsonObject,
  sha256Json,
  sha256Text,
  type CatalogTool,
  type GatewayCallMeta,
  type JsonObject,
} from "@morrow/contracts";
import { projectOutput, type OutputPrivacyContext } from "./privacy.js";

export interface ResultContext {
  readonly mapping: CatalogTool;
  readonly catalogDigest: string;
  readonly operation?: {
    readonly operationId: string;
    readonly state: string;
    readonly sourceOperationId?: string;
  };
  readonly privacy?: OutputPrivacyContext;
}

export interface CanonicalMorrowResultInput {
  readonly result?: JsonObject;
  readonly operationId?: string;
  readonly tool: string;
  readonly phase: string;
  readonly effectState?: string;
  readonly verificationStatus: "not_applicable" | "not_requested" | "unconfirmed" | "verified";
  readonly attention?: readonly string[];
  readonly limitations?: readonly string[];
  readonly receipts?: JsonObject;
}

export function canonicalMorrowResult(input: CanonicalMorrowResultInput): JsonObject {
  const upstream = input.result ? structuredClone(input.result) : {};
  const structured = isJsonObject(upstream.structuredContent)
    ? structuredClone(upstream.structuredContent)
    : null;
  const meta = isJsonObject(upstream._meta) ? structuredClone(upstream._meta) : {};
  return {
    content: Array.isArray(upstream.content)
      ? structuredClone(upstream.content)
      : [{ type: "text", text: `Morrow ${input.phase.replaceAll("_", " ")}.` }],
    ...(upstream.isError === true ? { isError: true } : {}),
    structuredContent: {
      schema: "morrow.result.v1",
      tool: input.tool,
      phase: input.phase,
      ...(input.operationId ? { operationId: input.operationId } : {}),
      ...(input.effectState ? { effectState: input.effectState } : {}),
      verification: {
        status: input.verificationStatus,
      },
      ...(input.receipts ? { receipts: structuredClone(input.receipts) } : {}),
      ...(input.attention && input.attention.length > 0 ? { attention: [...input.attention] } : {}),
      ...(input.limitations && input.limitations.length > 0 ? { limitations: [...input.limitations] } : {}),
      ...(structured ? { data: structured } : {}),
    },
    _meta: meta,
  };
}

function textError(text: string, detailDigest: string): JsonObject {
  return {
    content: [{ type: "text", text }],
    isError: true,
    structuredContent: {
      schema: "morrow.problem.v1",
      code: "upstream_result_invalid",
      detailDigest,
    },
  };
}

function callMeta(
  context: ResultContext,
  upstreamResultSha256: string,
): GatewayCallMeta {
  return {
    schema: "morrow.gateway.call.v1",
    publicToolName: context.mapping.publicName,
    upstreamId: context.mapping.upstreamId,
    upstreamToolName: context.mapping.upstreamName,
    catalogDigest: context.catalogDigest,
    upstreamResultSha256,
    ...(context.operation ? {
      gatewayOperationId: context.operation.operationId,
      gatewayOperationState: context.operation.state,
      ...(context.operation.sourceOperationId
        ? { sourceOperationId: context.operation.sourceOperationId }
        : {}),
    } : {}),
  };
}

export function normalizeUpstreamResult(value: unknown, context: ResultContext): JsonObject {
  if (!isJsonObject(value)) {
    return textError(
      "The upstream returned an invalid MCP tool result.",
      sha256Text(String(value)),
    );
  }

  const upstreamDigest = sha256Json(value);
  const projected = projectOutput(value, context.privacy);
  return {
    ...projected,
    _meta: {
      "io.morrow/gateway": callMeta(context, upstreamDigest),
    },
  };
}

export function safeUpstreamFailure(error: unknown, context: ResultContext): JsonObject {
  const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
  return {
    content: [{
      type: "text",
      text: `Morrow could not complete ${context.mapping.publicName} through its configured upstream.`,
    }],
    isError: true,
    structuredContent: {
      schema: "morrow.problem.v1",
      code: "upstream_call_failed",
      recoverable: true,
      source: context.mapping.upstreamId,
      detailDigest: sha256Text(detail),
    },
    _meta: {
      "io.morrow/gateway": callMeta(context, sha256Text(detail)),
    },
  };
}
