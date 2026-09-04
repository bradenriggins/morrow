import { randomUUID } from "node:crypto";
import { sha256Text, type JsonObject } from "@morrow/contracts";

export const MAX_INLINE_RESULT_CHARACTERS = 64_000;
export const MAX_RESULT_ARTIFACT_CHARACTERS = 1_000_000;
export const MAX_RESULT_ARTIFACTS = 16;
export const MAX_RESULT_PAGE_CHARACTERS = 16_000;

interface ResultArtifact {
  readonly handle: string;
  readonly text: string;
  readonly sha256: string;
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

  bound(result: JsonObject): JsonObject {
    const text = JSON.stringify(result);
    if (text.length <= MAX_INLINE_RESULT_CHARACTERS) return result;

    const gatewayMeta = result._meta;
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
      ...(result.isError === true ? { isError: true } : {}),
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

  page(handle: string, offset?: number, limit?: number): ResultArtifactPage {
    const artifact = this.artifacts.get(handle);
    if (!artifact) throw new Error("Morrow could not find the requested result artifact");
    const start = exactOffset(offset);
    const maximum = exactLimit(limit);
    const text = artifact.text.slice(start, start + maximum);
    const nextOffset = start + text.length < artifact.text.length ? start + text.length : null;
    return {
      schema: "morrow.result-page.v1",
      handle: artifact.handle,
      offset: start,
      returned: text.length,
      nextOffset,
      totalCharacters: artifact.text.length,
      sha256: artifact.sha256,
      text,
    };
  }
}
