import { randomUUID } from "node:crypto";
import type { ServerContext } from "@modelcontextprotocol/server";
import { isJsonObject, sha256Text, type JsonObject } from "@morrow/contracts";

export const MAX_INLINE_RESULT_CHARACTERS = 64_000;
export const MAX_RESULT_ARTIFACT_CHARACTERS = 2_000_000;
export const MAX_RESULT_ARTIFACTS = 16;
export const MAX_RESULT_PAGE_CHARACTERS = 16_000;
const ACTIVE_PAGE_IDLE_MS = 10 * 60_000;

interface ResultArtifact {
  readonly handle: string;
  readonly text: string;
  readonly sha256: string;
  audience?: string;
  protectedUntil?: number;
}

export interface ResultArtifactPage {
  readonly schema: "morrow.result-page.v1";
  readonly handle: string;
  readonly offset: number;
  readonly returned: number;
  readonly nextOffset: number | null;
  readonly totalCharacters: number;
  readonly sha256: string;
  readonly text: string;
}

export interface ResultArtifactConnectionContext {
  readonly workspaceRoot?: string;
  readonly proxyPid?: number;
}

/** Exact admitted MCP connection allowed to read one returned artifact. */
export function resultArtifactAudience(
  context: ServerContext,
  connection: ResultArtifactConnectionContext = {},
): string {
  const session = typeof context.sessionId === "string" && context.sessionId ? context.sessionId : "stdio-single-client";
  const client = typeof context.http?.authInfo?.clientId === "string" && context.http.authInfo.clientId
    ? context.http.authInfo.clientId
    : "local";
  if (connection.proxyPid !== undefined
    && (!Number.isSafeInteger(connection.proxyPid) || connection.proxyPid < 1)) {
    throw new TypeError("result artifact proxy process is invalid");
  }
  if (connection.workspaceRoot !== undefined && connection.workspaceRoot.length === 0) {
    throw new TypeError("result artifact workspace is invalid");
  }
  return sha256Text(JSON.stringify({
    schema: "morrow.result-artifact-audience.v1",
    session,
    client,
    proxyPid: connection.proxyPid ?? null,
    workspaceDigest: connection.workspaceRoot === undefined ? null : sha256Text(connection.workspaceRoot),
  }));
}

export function resolveResultArtifact(
  result: JsonObject,
  page: (handle: string, offset?: number) => ResultArtifactPage,
): JsonObject {
  const artifact = result.structuredContent;
  if (!isJsonObject(artifact) || artifact.schema !== "morrow.result-artifact.v1") return result;
  if (typeof artifact.handle !== "string" || typeof artifact.totalCharacters !== "number"
    || artifact.totalCharacters > MAX_RESULT_ARTIFACT_CHARACTERS) throw new Error("Saved result is unavailable.");
  let text = "";
  let offset: number | null = 0;
  do {
    const current = page(artifact.handle, offset);
    if (current.offset !== offset || typeof current.text !== "string"
      || (current.nextOffset !== null && typeof current.nextOffset !== "number")) {
      throw new Error("Saved result is incomplete.");
    }
    text += current.text;
    offset = current.nextOffset;
  } while (offset !== null);
  if (text.length !== artifact.totalCharacters) throw new Error("Saved result is incomplete.");
  const resolved: unknown = JSON.parse(text);
  if (!isJsonObject(resolved)) throw new Error("Saved result is invalid.");
  return resolved;
}

function exactOffset(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("result offset must be a non-negative whole number");
  }
  return value;
}

function exactLimit(value: number | undefined): number {
  if (value === undefined) return MAX_RESULT_PAGE_CHARACTERS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RESULT_PAGE_CHARACTERS) {
    throw new TypeError(`result limit must be a whole number from 1 through ${MAX_RESULT_PAGE_CHARACTERS}`);
  }
  return value;
}

export class ResultArtifactStore {
  private readonly artifacts = new Map<string, ResultArtifact>();

  bound(result: JsonObject, project?: (value: JsonObject) => JsonObject): JsonObject {
    const projected = project ? project(structuredClone(result)) : result;
    if (projected.resultType === "input_required"
      && isJsonObject(projected.inputRequests)
      && typeof projected.requestState === "string") {
      return projected;
    }
    const text = JSON.stringify(projected);
    if (text.length <= MAX_INLINE_RESULT_CHARACTERS) return projected;

    const gatewayMeta = projected._meta;
    if (text.length > MAX_RESULT_ARTIFACT_CHARACTERS) {
      return {
        content: [{
          type: "text",
          text: "Morrow did not return the upstream result because it exceeds the configured artifact limit.",
        }],
        isError: true,
        structuredContent: {
          schema: "morrow.problem.v1",
          code: "upstream_result_too_large",
          maximumCharacters: MAX_RESULT_ARTIFACT_CHARACTERS,
          actualCharacters: text.length,
          detailDigest: sha256Text(text),
        },
        ...(gatewayMeta ? { _meta: structuredClone(gatewayMeta) } : {}),
      };
    }

    while (this.artifacts.size >= MAX_RESULT_ARTIFACTS) {
      const available = [...this.artifacts.entries()].find(([, artifact]) => (artifact.protectedUntil ?? 0) <= Date.now());
      if (!available) return {
        isError: true,
        content: [{ type: "text", text: "Morrow received a large result, but all saved result slots are being read. Finish one saved result before requesting another large read." }],
        structuredContent: {
          schema: "morrow.problem.v1",
          code: "result_artifact_capacity",
          maximumArtifacts: MAX_RESULT_ARTIFACTS,
          detailDigest: sha256Text(text),
        },
        ...(gatewayMeta ? { _meta: structuredClone(gatewayMeta) } : {}),
      };
      this.artifacts.delete(available[0]);
    }
    const handle = `result:${randomUUID()}`;
    const artifact: ResultArtifact = {
      handle,
      text,
      sha256: sha256Text(text),
    };
    this.artifacts.set(handle, artifact);

    return {
      content: [{
        type: "text",
        text: "Morrow stored the large result as a bounded local artifact. Use morrow_result_page with this handle.",
      }],
      ...(projected.isError === true ? { isError: true } : {}),
      structuredContent: {
        schema: "morrow.result-artifact.v1",
        handle,
        totalCharacters: text.length,
        sha256: artifact.sha256,
        maximumPageCharacters: MAX_RESULT_PAGE_CHARACTERS,
      },
      ...(gatewayMeta ? { _meta: structuredClone(gatewayMeta) } : {}),
    };
  }

  bindAudience(value: JsonObject, audience: string): void {
    if (!audience || audience.length > 1_000) throw new TypeError("result artifact audience is invalid");
    const visit = (candidate: unknown): void => {
      if (Array.isArray(candidate)) {
        candidate.forEach(visit);
        return;
      }
      if (!isJsonObject(candidate)) return;
      if (candidate.schema === "morrow.result-artifact.v1" && typeof candidate.handle === "string") {
        const artifact = this.artifacts.get(candidate.handle);
        if (!artifact || (artifact.audience && artifact.audience !== audience)) {
          throw new Error("Morrow could not authorize the requested result artifact");
        }
        artifact.audience = audience;
      }
      Object.values(candidate).forEach(visit);
    };
    visit(value);
  }

  page(handle: string, offset?: number, limit?: number, audience?: string): ResultArtifactPage {
    const artifact = this.artifacts.get(handle);
    if (!artifact) throw new Error("This saved result expired. Request a fresh read to get it again.");
    if (artifact.audience && audience !== artifact.audience) {
      throw new Error("Morrow could not authorize the requested result artifact");
    }
    const serialized = artifact.text;
    const start = exactOffset(offset);
    const maximum = exactLimit(limit);
    const text = serialized.slice(start, start + maximum);
    const nextOffset = start + text.length < serialized.length ? start + text.length : null;
    artifact.protectedUntil = nextOffset === null ? 0 : Date.now() + ACTIVE_PAGE_IDLE_MS;
    this.artifacts.delete(handle);
    this.artifacts.set(handle, artifact);
    return {
      schema: "morrow.result-page.v1",
      handle: artifact.handle,
      offset: start,
      returned: text.length,
      nextOffset,
      totalCharacters: serialized.length,
      sha256: sha256Text(serialized),
      text,
    };
  }
}
