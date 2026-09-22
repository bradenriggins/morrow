import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readExactTrustJson } from "../lib/exact-trust-file.mjs";

function fixture(t, name) {
  const directory = mkdtempSync(join(tmpdir(), "morrow-release-exact-trust-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, name);
}

test("release exact trust JSON rejects malformed UTF-8 before JSON parsing", (t) => {
  const path = fixture(t, "release-policy.json");
  writeFileSync(path, Buffer.concat([
    Buffer.from('{"label":"mor'),
    Buffer.from([0xff]),
    Buffer.from('row"}\n'),
  ]));

  assert.throws(
    () => readExactTrustJson(path, { label: "Release policy", maxBytes: 1024 }),
    /Release policy is not valid UTF-8/u,
  );
});

test("release exact trust JSON accepts a valid UTF-8 BOM", (t) => {
  const path = fixture(t, "release-policy.json");
  writeFileSync(path, Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('{"policy":"strict"}\n'),
  ]));

  assert.deepEqual(
    readExactTrustJson(path, { label: "Release policy", maxBytes: 1024 }),
    { policy: "strict" },
  );
});
