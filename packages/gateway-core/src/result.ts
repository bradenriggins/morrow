import {
  isJsonObject,
  sha256Json,
  sha256Text,
  type CatalogTool,
  type GatewayCallMeta,
  type JsonObject,
} from "@morrow/contracts";

export interface ResultContext {
  readonly mapping: CatalogTool;
  readonly catalogDigest: string;
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

export function normalizeUpstreamResult(value: unknown, context: ResultContext): JsonObject {
  if (!isJsonObject(value)) {
    return textError(
      "The upstream returned an invalid MCP tool result.",
      sha256Text(String(value)),
    );
  }

  const upstreamDigest = sha256Json(value);
  const meta: GatewayCallMeta = {
    schema: "morrow.gateway.call.v1",
    publicToolName: context.mapping.publicName,
    upstreamId: context.mapping.upstreamId,
    upstreamToolName: context.mapping.upstreamName,
    catalogDigest: context.catalogDigest,
    upstreamResultSha256: upstreamDigest,
  };

  const output: JsonObject = {
    content: Array.isArray(value.content)
      ? structuredClone(value.content)
      : [{ type: "text", text: "The upstream returned no MCP content blocks." }],
    ...(typeof value.isError === "boolean" ? { isError: value.isError } : {}),
    ...(isJsonObject(value.structuredContent)
      ? { structuredContent: structuredClone(value.structuredContent) }
      : {}),
    _meta: {
      ...(isJsonObject(value._meta) ? structuredClone(value._meta) : {}),
      "io.morrow/gateway": meta,
    },
  };

  return output;
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
      "io.morrow/gateway": {
        schema: "morrow.gateway.call.v1",
        publicToolName: context.mapping.publicName,
        upstreamId: context.mapping.upstreamId,
        upstreamToolName: context.mapping.upstreamName,
        catalogDigest: context.catalogDigest,
        upstreamResultSha256: sha256Text(detail),
      } satisfies GatewayCallMeta,
    },
  };
}
