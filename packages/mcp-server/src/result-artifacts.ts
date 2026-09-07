import { randomUUID } from "node:crypto";
import { isJsonObject, sha256Text, type JsonObject } from "@morrow/contracts";

export const MAX_INLINE_RESULT_CHARACTERS = 64_000;
export const MAX_RESULT_ARTIFACT_CHARACTERS = 1_000_000;
export const MAX_RESULT_ARTIFACTS = 16;
export const MAX_RESULT_PAGE_CHARACTERS = 16_000;

interface ResultArtifact {
  readonly handle: string;
  readonly text: string;
  readonly sha256: string;
  readonly project?: (value: JsonObject) => JsonObject;
  audience?: string;
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

    const handle = `result:${randomUUID()}`;
    const artifact: ResultArtifact = {
      handle,
      text,
      sha256: sha256Text(text),
      ...(project ? { project } : {}),
    };
    this.artifacts.set(handle, artifact);
    while (this.artifacts.size > MAX_RESULT_ARTIFACTS) {
      const oldest = this.artifacts.keys().next().value;
      if (typeof oldest !== "string") break;
      this.artifacts.delete(oldest);
    }

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
    if (!artifact) throw new Error("Morrow could not find the requested result artifact");
    if (artifact.audience && audience !== artifact.audience) {
      throw new Error("Morrow could not authorize the requested result artifact");
    }
    let serialized = artifact.text;
    if (artifact.project) {
      const parsed: unknown = JSON.parse(serialized);
      if (!isJsonObject(parsed)) throw new Error("Morrow could not read the requested result artifact");
      serialized = JSON.stringify(artifact.project(parsed));
    }
    const start = exactOffset(offset);
    const maximum = exactLimit(limit);
    const text = serialized.slice(start, start + maximum);
    const nextOffset = start + text.length < serialized.length ? start + text.length : null;
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
