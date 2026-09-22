"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const {
  createBoundedCommandReader,
  readBoundedCommandOutput,
} = require("../shared/process-lifetime.cjs");

function stalledChild() {
  const child = new EventEmitter();
  child.pid = 43_210;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.unrefCalls = 0;
  child.unref = () => { child.unrefCalls += 1; };
  return child;
}

test("bounded command ownership settles and releases pipes when close never arrives", async () => {
  const child = stalledChild();
  const terminations = [];
  const read = createBoundedCommandReader({
    spawnProcess: () => child,
    platform: "darwin",
    terminateTree: (_owned, force) => { terminations.push(force); },
  });

  const result = await read("fixture", [], {
    timeoutMs: 10,
    maxBytes: 64,
    killGraceMs: 10,
    finalGraceMs: 10,
    includeStderr: true,
  });

  assert.equal(result, null);
  assert.deepEqual(terminations, [false, true]);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.unrefCalls, 1);
});

test("bounded command output can include the diagnostic stream without losing its byte limit", async () => {
  const output = await readBoundedCommandOutput(process.execPath, ["-e", [
    "process.stdout.write('standard\\n');",
    "process.stderr.write('diagnostic\\n');",
  ].join("")], {
    timeoutMs: 5_000,
    maxBytes: 4_096,
    includeStderr: true,
  });

  assert.match(output, /standard/);
  assert.match(output, /diagnostic/);
});
