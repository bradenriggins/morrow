import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readExactTrustJson } from "../src/exact-trust-file.js";

const directories: string[] = [];

function fixturePath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), "morrow-exact-trust-"));
  directories.push(directory);
  return join(directory, name);
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("exact trust JSON", () => {
  it("rejects malformed UTF-8 before JSON parsing can admit replacement text", () => {
    const path = fixturePath("configuration.json");
    writeFileSync(path, Buffer.concat([
      Buffer.from('{"label":"mor'),
      Buffer.from([0xff]),
      Buffer.from('row"}\n'),
    ]));

    expect(() => readExactTrustJson(path, { label: "Gateway configuration", maxBytes: 1024 }))
      .toThrow("Gateway configuration is not valid UTF-8");
  });

  it("keeps UTF-8 BOM compatibility for a valid exact trust document", () => {
    const path = fixturePath("policy.json");
    writeFileSync(path, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{"policy":"strict"}\n'),
    ]));

    expect(readExactTrustJson(path, { label: "Publication policy", maxBytes: 1024 }))
      .toEqual({ policy: "strict" });
  });
});
