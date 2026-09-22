import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { serveBrandAsset } from "../src/brand.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function responseCapture(): {
  response: ServerResponse;
  result: { status: number | null; headers: Record<string, string> | null; body: Buffer | null };
} {
  const result: { status: number | null; headers: Record<string, string> | null; body: Buffer | null } = {
    status: null,
    headers: null,
    body: null,
  };
  const response = {
    writeHead(status: number, headers: Record<string, string>) {
      result.status = status;
      result.headers = headers;
      return this;
    },
    end(body: Buffer) {
      result.body = body;
      return this;
    },
  } as unknown as ServerResponse;
  return { response, result };
}

describe("serveBrandAsset", () => {
  it("serves the sealed application asset when the package runs from pnpm node_modules", () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-packaged-brand-"));
    temporaryDirectories.push(directory);
    const brandDirectory = join(directory, "app", "connector", "extension", "brand");
    mkdirSync(brandDirectory, { recursive: true });
    const expected = Buffer.from("packaged-theme", "utf8");
    writeFileSync(join(brandDirectory, "theme.css"), expected);
    const moduleUrl = pathToFileURL(join(
      directory,
      "app",
      "node_modules",
      "@morrow",
      "bridge-loopback",
      "dist",
      "brand.js",
    ));
    const { response, result } = responseCapture();

    expect(serveBrandAsset("/morrow-brand/theme.css", response, moduleUrl)).toBe(true);
    expect(result).toMatchObject({
      status: 200,
      headers: {
        "content-type": "text/css; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
      body: expected,
    });
  });

  it("does not end the server when an allowlisted asset is absent", () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-missing-brand-"));
    temporaryDirectories.push(directory);
    const moduleUrl = pathToFileURL(join(directory, "app", "node_modules", "@morrow", "bridge-loopback", "dist", "brand.js"));
    const { response, result } = responseCapture();

    expect(serveBrandAsset("/morrow-brand/theme.css", response, moduleUrl)).toBe(false);
    expect(result).toEqual({ status: null, headers: null, body: null });
  });
});
