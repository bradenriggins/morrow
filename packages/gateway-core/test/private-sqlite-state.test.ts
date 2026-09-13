import { chmodSync, closeSync, constants, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openExactPrivateSqliteDatabase } from "../src/private-sqlite-state.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "morrow-private-sqlite-"));
  roots.push(root);
  return { root, path: join(root, "state.sqlite3") };
}

function emptyPrivateFile(path: string): void {
  const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  closeSync(descriptor);
}

describe("exact private SQLite state", () => {
  it("creates the database, WAL, and shared-memory files with private access under a normal process mask", () => {
    const { path } = fixture();
    const previous = process.umask(0o022);
    try {
      const opened = openExactPrivateSqliteDatabase(path, "test database");
      opened.database.exec("CREATE TABLE private_rows(value TEXT); INSERT INTO private_rows VALUES ('private marker');");
      if (process.platform !== "win32") {
        for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
          expect(lstatSync(candidate).mode & 0o077).toBe(0);
        }
      }
      opened.database.close();
    } finally {
      process.umask(previous);
    }
  });

  it.runIf(process.platform !== "win32")("tightens one legacy broadly readable database before opening it", () => {
    const { path } = fixture();
    emptyPrivateFile(path);
    chmodSync(path, 0o644);
    const opened = openExactPrivateSqliteDatabase(path, "test database");
    expect(lstatSync(path).mode & 0o077).toBe(0);
    opened.database.close();
  });

  it.runIf(process.platform !== "win32")("refuses a shared parent without changing an existing file", () => {
    const { root } = fixture();
    const shared = join(root, "shared");
    mkdirSync(shared, { mode: 0o755 });
    const path = join(shared, "state.sqlite3");
    emptyPrivateFile(path);
    chmodSync(path, 0o644);
    expect(() => openExactPrivateSqliteDatabase(path, "test database")).toThrow("directory access is not private");
    expect(lstatSync(path).mode & 0o077).toBe(0o044);
  });

  it("refuses a final symbolic link without changing its target", () => {
    const { root, path } = fixture();
    const outside = join(root, "outside.sqlite3");
    writeFileSync(outside, "outside marker", { mode: 0o600 });
    symlinkSync(outside, path);
    expect(() => openExactPrivateSqliteDatabase(path, "test database")).toThrow("not one exact private file");
    expect(readFileSync(outside, "utf8")).toBe("outside marker");
  });

  it("refuses a multiply linked database", () => {
    const { root, path } = fixture();
    emptyPrivateFile(path);
    linkSync(path, join(root, "state.alias"));
    expect(() => openExactPrivateSqliteDatabase(path, "test database")).toThrow("not one exact private file");
  });

  it("refuses a linked SQLite sidecar before the database can open it", () => {
    const { root, path } = fixture();
    emptyPrivateFile(path);
    const outside = join(root, "outside.wal");
    writeFileSync(outside, "outside marker", { mode: 0o600 });
    symlinkSync(outside, `${path}-wal`);
    expect(() => openExactPrivateSqliteDatabase(path, "test database")).toThrow("not one exact private file");
  });
});
