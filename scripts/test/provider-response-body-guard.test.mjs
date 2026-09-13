import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { analyseProviderSource } from "./lib/provider-response-analysis.mjs";

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

async function providerFindings() {
  const awaited = [];
  const abandoned = [];
  let analysed = 0;
  for (const relativeRoot of productionRoots) {
    for (const absolute of await sourceFiles(path.join(root, relativeRoot))) {
      const relative = path.relative(root, absolute);
      const findings = analyseProviderSource(relative, await readFile(absolute, "utf8"));
      analysed += 1;
      awaited.push(...findings.awaitedCancellations.map((finding) => `${relative}:${finding}`));
      abandoned.push(...findings.unconsumedExits.map((finding) => `${relative}:${finding}`));
    }
  }
  assert.ok(analysed >= 60, `the guard must analyse the complete provider source class, saw ${analysed} files`);
  return { awaited, abandoned };
}

test("no provider path waits on a body or reader cancellation, however the promise flows", async () => {
  const { awaited } = await providerFindings();
  assert.deepEqual(awaited, []);
});

test("every exit that abandons a live provider response cancels its body on that path", async () => {
  const { abandoned } = await providerFindings();
  assert.deepEqual(abandoned, []);
});

// Each fixture preserves the forbidden behaviour under a shape the former
// text-window guards accepted: a cancellation awaited through a variable, a
// helper, or a combinator; a refusal written without `!response.ok`; a
// declared-length refusal whose reader sits beyond a nine-line window; and a
// response handed to a reading helper instead of `getReader` on the spot.
const FORBIDDEN = [
  {
    name: "a cancellation awaited through a variable",
    source: `
async function readBounded(response) {
  const reader = response.body.getReader();
  const next = await reader.read();
  if (next.value.byteLength > LIMIT) {
    const settled = reader.cancel();
    await settled;
    return "limit";
  }
  return next.value;
}`,
    expected: { awaitedCancellations: ["7:awaits a cancellation"], unconsumedExits: [] },
  },
  {
    name: "a cancellation awaited through a renamed helper",
    source: `
const discard = (body) => body?.cancel?.();
async function readBounded(response) {
  const reader = response.body.getReader();
  const next = await reader.read();
  if (next.value.byteLength > LIMIT) {
    await discard(reader);
    return "limit";
  }
  return next.value;
}`,
    expected: { awaitedCancellations: ["7:awaits a cancellation"], unconsumedExits: [] },
  },
  {
    name: "a cancellation awaited inside a promise combinator and a chained catch",
    source: `
async function readBounded(response) {
  const reader = response.body.getReader();
  const next = await reader.read();
  if (next.done) return "";
  await Promise.all([reader.cancel().catch(() => {}), Promise.resolve()]);
  return "limit";
}`,
    expected: { awaitedCancellations: ["6:awaits a cancellation"], unconsumedExits: [] },
  },
  {
    name: "an async helper that settles with the cancellation",
    source: `
async function stop(reader) {
  return reader.cancel();
}
async function readBounded(response) {
  const reader = response.body.getReader();
  const next = await reader.read();
  if (next.done) return "";
  await stop(reader);
  return "limit";
}`,
    expected: { awaitedCancellations: ["3:an async function settles with a cancellation", "9:awaits a cancellation"], unconsumedExits: [] },
  },
  {
    name: "a refusal that is not spelled with !response.ok",
    source: `
async function boundedText(response, expected) {
  if (response.ok === false || response.url !== expected) return null;
  const reader = response.body.getReader();
  return read(reader);
}`,
    expected: { awaitedCancellations: [], unconsumedExits: ["3:leaves response live without cancelling its body"] },
  },
  {
    name: "a declared-length refusal whose reader sits beyond a nine-line window",
    source: `
async function boundedText(response) {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > LIMIT) {
    return "limit";
  }
  const first = 1;
  const second = 2;
  const third = 3;
  const fourth = 4;
  const fifth = 5;
  const sixth = 6;
  const seventh = 7;
  const reader = response.body.getReader();
  return read(reader);
}`,
    expected: { awaitedCancellations: [], unconsumedExits: ["5:leaves response live without cancelling its body"] },
  },
  {
    name: "a fetched response refused before it reaches the reading helper",
    source: `
async function readBounded(response) {
  const reader = response.body.getReader();
  try { return await read(reader); } catch { try { void reader.cancel().catch(() => {}); } catch {} return null; }
}
async function load(url) {
  let response;
  try { response = await fetch(url); } catch { return null; }
  if (!response.ok || response.url !== url) return null;
  return readBounded(response);
}`,
    expected: { awaitedCancellations: [], unconsumedExits: ["9:leaves response live without cancelling its body"] },
  },
  {
    name: "a cancellation that runs only on another branch",
    source: `
async function boundedText(response) {
  if (response.headers.get("content-length") === "0") {
    try { void response.body?.cancel?.().catch(() => {}); } catch {}
    return "";
  }
  if (!response.ok) return null;
  const reader = response.body.getReader();
  return read(reader);
}`,
    expected: { awaitedCancellations: [], unconsumedExits: ["7:leaves response live without cancelling its body"] },
  },
];

const PERMITTED = [
  {
    name: "cancellation that is started, observed, and never waited on",
    source: `
async function boundedText(response, expected) {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > LIMIT) {
    try { const cancellation = response?.body?.cancel?.(); if (cancellation && typeof cancellation.catch === "function") void cancellation.catch(() => {}); } catch {}
    return "limit";
  }
  if (!response.ok || response.url !== expected) {
    try { void response.body?.cancel?.().catch(() => {}); } catch {}
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  try {
    return await read(reader);
  } catch {
    const cancellation = reader.cancel();
    cancellation.catch(() => {});
    return null;
  }
}`,
  },
  {
    name: "a response abandoned only when it has no body, and a fetch failure with no response",
    source: `
async function load(url) {
  let response;
  try { response = await fetch(url); } catch { return null; }
  if (response.type === "opaqueredirect") return { sent: true };
  if (!response.body) return "";
  const html = await boundedText(response);
  if (!html) return null;
  return html;
}
const request = async (url) => { try { return await fetch(url); } catch { return null; } };
async function json(url) {
  const response = await request(url);
  if (!response) return null;
  return boundedJson(response);
}`,
  },
  {
    name: "a cancelling helper named freely, used before every refusal",
    source: `
const drop = (body) => { try { const cancellation = body?.cancel?.(); if (cancellation && typeof cancellation.catch === "function") void cancellation.catch(() => {}); } catch {} };
async function boundedText(response) {
  if (response.ok !== true) { drop(response.body); return null; }
  const body = response.body;
  const reader = body.getReader();
  return read(reader);
}`,
  },
];

test("the response guards fail every trivial rewrite that preserves the forbidden behaviour", () => {
  for (const fixture of FORBIDDEN) {
    assert.deepEqual(analyseProviderSource("fixture.js", fixture.source), fixture.expected, fixture.name);
  }
  for (const fixture of PERMITTED) {
    assert.deepEqual(analyseProviderSource("fixture.js", fixture.source), { awaitedCancellations: [], unconsumedExits: [] }, fixture.name);
  }
});
