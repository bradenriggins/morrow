import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExactPrivateStateFile, readExactPrivateStateFile } from "../src/private-state-file.js";

/**
 * A descriptor stat whose reported timestamps drift after the file was
 * written, the way a multigrain-timestamp kernel refines a freshly written
 * inode's ctime once it has been queried. Nothing about the file changes.
 */
const drift = vi.hoisted(() => ({ ctimeMs: 0, mtimeMs: 0, calls: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const fstatSync: typeof actual.fstatSync = ((descriptor: number, options?: unknown) => {
    const stats = actual.fstatSync(descriptor, options as never) as import("node:fs").Stats;
    drift.calls += 1;
    return Object.assign(Object.create(Object.getPrototypeOf(stats)) as import("node:fs").Stats, stats, {
      ctimeMs: stats.ctimeMs + drift.ctimeMs * drift.calls,
      mtimeMs: stats.mtimeMs + drift.mtimeMs * drift.calls,
    });
  }) as typeof actual.fstatSync;
  return { ...actual, fstatSync };
});

const roots: string[] = [];
afterEach(async () => {
  drift.ctimeMs = 0;
  drift.mtimeMs = 0;
  drift.calls = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function privateFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "morrow-private-state-file-"));
  roots.push(root);
  const directory = join(root, "state");
  await mkdir(directory, { mode: 0o700 });
  return join(directory, "state.json");
}

const options = { label: "probe state", maxBytes: 4_096, minBytes: 1 };

describe("readExactPrivateStateFile", () => {
  it("reads a file whose ctime the kernel refines after the write with nothing else changed", async () => {
    const path = await privateFile();
    drift.ctimeMs = 0.5;
    expect(createExactPrivateStateFile(path, Buffer.from('{"revision":1}\n'), options)).toBe(true);
    expect(readExactPrivateStateFile(path, options)?.toString("utf8")).toBe('{"revision":1}\n');
    expect(drift.calls).toBeGreaterThanOrEqual(4);
  });

  it("still refuses a file whose content timestamp moves while it is read", async () => {
    const path = await privateFile();
    expect(createExactPrivateStateFile(path, Buffer.from('{"revision":1}\n'), options)).toBe(true);
    drift.mtimeMs = 0.5;
    expect(() => readExactPrivateStateFile(path, options)).toThrow("probe state changed while it was read");
  });
});
