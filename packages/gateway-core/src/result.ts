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
