import assert from "node:assert/strict";
import { isUtf8 } from "node:buffer";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const emDash = Buffer.from([0xe2, 0x80, 0x94]);

function websiteFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? websiteFiles(path) : [path];
  });
}

test("tracked source and the public website contain no em dash", () => {
  const listed = spawnSync("git", ["-C", root, "ls-files", "-z"], { encoding: "buffer" });
  assert.equal(listed.status, 0, listed.stderr.toString("utf8"));

  const tracked = listed.stdout.toString("utf8").split("\0").filter(Boolean).map((path) => join(root, path));
  const files = [...new Set([...tracked, ...websiteFiles(join(root, "website"))])];
  const found = [];

  for (const path of files) {
    const contents = readFileSync(path);
    if (!isUtf8(contents) || contents.includes(0)) continue;
    if (contents.includes(emDash)) found.push(path.slice(root.length + 1));
  }

  assert.deepEqual(found, [], "replace the em dash with sentence punctuation or a clearer sentence boundary");
});

test("public pages do not encode an em dash as an HTML entity", () => {
  const found = [];
  for (const path of websiteFiles(join(root, "website")).filter((file) => file.endsWith(".html"))) {
    const contents = readFileSync(path, "utf8");
    if (/&(?:mdash|#0*8212|#x0*2014);/i.test(contents)) found.push(path.slice(root.length + 1));
  }
  assert.deepEqual(found, []);
});
