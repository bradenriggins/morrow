import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readExactTrustJson } from "../src/exact-trust-file.js";

const descriptorDrift = vi.hoisted(() => ({ ctimeNs: 0n, mtimeNs: 0n, calls: 0n }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const fstatSync: typeof actual.fstatSync = ((descriptor: number, options?: unknown) => {
    const info = actual.fstatSync(descriptor, options as never) as import("node:fs").BigIntStats;
    if (typeof info.ctimeNs !== "bigint") return info;
    descriptorDrift.calls += 1n;
    return Object.assign(Object.create(Object.getPrototypeOf(info)) as import("node:fs").BigIntStats, info, {
      ctimeNs: info.ctimeNs + descriptorDrift.ctimeNs * descriptorDrift.calls,
      mtimeNs: info.mtimeNs + descriptorDrift.mtimeNs * descriptorDrift.calls,
    });
  }) as typeof actual.fstatSync;
  return { ...actual, fstatSync };
});

const directories: string[] = [];

function fixturePath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), "morrow-exact-trust-"));
  directories.push(directory);
  return join(directory, name);
}

afterEach(() => {
  descriptorDrift.ctimeNs = 0n;
  descriptorDrift.mtimeNs = 0n;
  descriptorDrift.calls = 0n;
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("exact trust JSON", () => {
  it("accepts ctime precision drift and still rejects mtime drift", () => {
    const path = fixturePath("stable.json");
    writeFileSync(path, '{"policy":"strict"}\n');
    descriptorDrift.ctimeNs = 500_000n;
    expect(readExactTrustJson(path, { label: "Publication policy", maxBytes: 1024 }))
      .toEqual({ policy: "strict" });

    descriptorDrift.ctimeNs = 0n;
    descriptorDrift.mtimeNs = 500_000n;
    descriptorDrift.calls = 0n;
    expect(() => readExactTrustJson(path, { label: "Publication policy", maxBytes: 1024 }))
      .toThrow("Publication policy path changed while it was read");
  });

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
