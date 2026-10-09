"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const {
  createBoundedCommandReader,
  matchExactProcessStart,
  parseDarwinKinfoStart,
  readBoundedCommandOutput,
  readProcessStartObservation,
  readProcessStartTimes,
  terminatePidTree,
  terminateProcessTree,
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

/** A command reader whose program answers only after `answerAfterMs`. */
function slowCommandReader(answerAfterMs, answer, calls = []) {
  return async (executable, argumentsValue, options) => {
    calls.push({ executable, argumentsValue, options });
    return options.timeoutMs > answerAfterMs ? answer(argumentsValue) : null;
  };
}

test("Windows tree termination uses taskkill for the whole tree and force escalation", () => {
  const launches = [];
  const child = { pid: 9876, kill() { throw new Error("fallback should not run"); } };
  const spawnProcess = (command, args, options) => {
    launches.push({ command, args, options });
    const killer = new EventEmitter();
    killer.unref = () => {};
    return killer;
  };

  assert.equal(terminateProcessTree(child, false, "win32", spawnProcess), true);
  assert.equal(terminatePidTree(4242, true, "win32", spawnProcess), true);
  assert.deepEqual(launches.map(({ command, args }) => [command, args]), [
    ["taskkill.exe", ["/PID", "9876", "/T"]],
    ["taskkill.exe", ["/PID", "4242", "/T", "/F"]],
  ]);
  assert.equal(launches.every(({ options }) => options.windowsHide === true && options.stdio === "ignore"), true);
});

function darwinKinfo(pid, startedAtMs) {
  const buffer = Buffer.alloc(64);
  const seconds = Math.floor(startedAtMs / 1_000);
  buffer.writeBigInt64LE(BigInt(seconds), 0);
  buffer.writeInt32LE((startedAtMs % 1_000) * 1_000, 8);
  buffer.writeInt32LE(pid, 40);
  return buffer;
}

test("a binary command result keeps bytes a text decode would change", async () => {
  const output = await readBoundedCommandOutput(process.execPath, ["-e", "process.stdout.write(Buffer.from([0xff, 0x00, 0x80]))"], {
    timeoutMs: 5_000,
    binary: true,
  });
  assert.ok(Buffer.isBuffer(output));
  assert.deepEqual([...output], [0xff, 0x00, 0x80]);
});

test("macOS kernel start time is fine enough to authorize a signal, and a one-second clock is not", async () => {
  const pid = 4242;
  const startedAt = Date.parse("2026-09-14T00:00:00.123Z");
  const kernel = darwinKinfo(pid, startedAt);
  assert.deepEqual(parseDarwinKinfoStart(kernel, pid), { at: startedAt, resolutionMs: 1 });
  assert.equal(parseDarwinKinfoStart(kernel, pid + 1), null, "a struct whose pid is not the process we asked for is not an identity");
  assert.equal(parseDarwinKinfoStart(Buffer.alloc(64), pid), null);
  assert.equal(matchExactProcessStart(startedAt, { at: startedAt, resolutionMs: 1 }), true);
  assert.equal(matchExactProcessStart(startedAt + 2, { at: startedAt, resolutionMs: 1 }), false);

  const calls = [];
  const observed = await readProcessStartObservation(pid, {
    platform: "darwin",
    processAlive: () => true,
    readCommand: async (executable, args, options) => {
      calls.push({ executable, args, binary: options.binary === true });
      return executable === "/usr/sbin/sysctl" ? kernel : null;
    },
  });
  assert.deepEqual(observed, { at: startedAt, resolutionMs: 1 });
  assert.equal(matchExactProcessStart(startedAt, observed), true);
  assert.deepEqual(calls, [{ executable: "/usr/sbin/sysctl", args: ["-b", `kern.proc.pid.${pid}`], binary: true }]);

  const coarseAt = Date.parse("Mon Sep 14 00:00:00 2026");
  const coarse = await readProcessStartObservation(pid, {
    platform: "darwin",
    processAlive: () => true,
    readCommand: async (executable) => executable === "/bin/ps" ? `${pid} Mon Sep 14 00:00:00 2026\n` : null,
  });
  assert.equal(coarse.resolutionMs, 1_000);
  assert.equal(matchExactProcessStart(coarseAt, coarse), null, "a whole-second clock still cannot authorize a signal");
});

test("a Windows process start query waits for a cold PowerShell start", async () => {
  const calls = [];
  const started = await readProcessStartTimes([4242], {
    platform: "win32",
    readCommand: slowCommandReader(4_000, () => '{"processId":4242,"startedAt":"2026-09-22T10:00:00.0000000Z"}', calls),
  });
  assert.deepEqual([...started], [[4242, Date.parse("2026-09-22T10:00:00Z")]]);
  assert.match(calls[0].executable, /powershell\.exe$/i);
  assert.ok(calls[0].options.timeoutMs < 15_000, "the query stays inside the runtime monitor's 15 s connect limit");
});
