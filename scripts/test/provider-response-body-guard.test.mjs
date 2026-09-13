import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const productionRoots = [
  "connector/extension/src",
  "packages/blackboard-learn-api/src",
];

const localExceptions = new Set([
  "connector/extension/src/bridge-maintenance.js:try { bytes = new Uint8Array(await response.arrayBuffer()); } catch { fail(\"bridge_active_folder_unconfirmed\"); }",
]);

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(absolute));
    } else if (/\.(?:js|mjs|ts)$/.test(entry.name)) {
      files.push(absolute);
    }
  }
  return files;
}

test("provider paths do not use full-body Response decoders", async () => {
  const observed = new Set();
  const unexpected = [];

  for (const relativeRoot of productionRoots) {
    for (const absolute of await sourceFiles(path.join(root, relativeRoot))) {
      const relative = path.relative(root, absolute);
      const source = await readFile(absolute, "utf8");
      const lines = source.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        for (const match of line.matchAll(/\.(text|json|arrayBuffer)\s*\(/g)) {
          const key = `${relative}:${line.trim()}`;
          if (!localExceptions.has(key)) {
            unexpected.push(`${relative}:${index + 1}:${match[1]}`);
            continue;
          }
          observed.add(key);
        }
      }
    }
  }

  assert.deepEqual(unexpected, []);
  assert.deepEqual([...observed].sort(), [...localExceptions].sort());
});

test("every provider byte-to-text boundary rejects malformed UTF-8", async () => {
  const unsafe = [];
  let decoders = 0;
  for (const relativeRoot of productionRoots) {
    for (const absolute of await sourceFiles(path.join(root, relativeRoot))) {
      const relative = path.relative(root, absolute);
      const lines = (await readFile(absolute, "utf8")).split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].includes("new TextDecoder")) continue;
        decoders += 1;
        if (!/new TextDecoder\(["']utf-8["'],\s*\{\s*fatal:\s*true\b/.test(lines[index])) {
          unsafe.push(`${relative}:${index + 1}`);
        }
      }
    }
  }
  assert.ok(decoders > 0, "the guard must inspect the provider decoders");
  assert.deepEqual(unsafe, []);
});

test("provider readers never await cancellation on a terminal path", async () => {
  const unsafe = [];
  for (const relativeRoot of productionRoots) {
    for (const absolute of await sourceFiles(path.join(root, relativeRoot))) {
      const relative = path.relative(root, absolute);
      const lines = (await readFile(absolute, "utf8")).split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (/\bawait\s+[^;\n]*\.cancel\s*\(/.test(lines[index])) unsafe.push(`${relative}:${index + 1}`);
      }
    }
  }
  assert.deepEqual(unsafe, []);
});

test("provider readers cancel bodies rejected by their declared byte limit", async () => {
  const unsafe = [];
  for (const relativeRoot of productionRoots) {
    for (const absolute of await sourceFiles(path.join(root, relativeRoot))) {
      const relative = path.relative(root, absolute);
      const lines = (await readFile(absolute, "utf8")).split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (!/["']content-length["']/.test(lines[index])) continue;
        const window = lines.slice(index, index + 9).join("\n");
        if (!window.includes("getReader")) continue;
        if (!/(?:\.cancel|\bcancelBody|\bcancel)\s*(?:\?\.)?\s*\(/.test(window)) unsafe.push(`${relative}:${index + 1}`);
      }
    }
  }
  assert.deepEqual(unsafe, []);
});

test("provider readers cancel bodies rejected before reader acquisition", async () => {
  const unsafe = [];
  for (const relativeRoot of productionRoots) {
    for (const absolute of await sourceFiles(path.join(root, relativeRoot))) {
      const relative = path.relative(root, absolute);
      const lines = (await readFile(absolute, "utf8")).split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].includes("if (!response")) continue;
        const window = lines.slice(index, index + 5).join("\n");
        if ((!window.includes("!response?.ok") && !window.includes("!response.ok")) || !window.includes("getReader")) continue;
        if (!/(?:\.cancel|\bcancelBody|\bcancel)\s*(?:\?\.)?\s*\(/.test(window)) unsafe.push(`${relative}:${index + 1}`);
      }
    }
  }
  assert.deepEqual(unsafe, []);
});
