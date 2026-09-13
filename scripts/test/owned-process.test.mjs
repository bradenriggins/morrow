import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  createOwnedProcessRunner,
  runOwnedProcess,
  terminateProcessTree,
} from "../lib/owned-process.mjs";

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

test("owned process output stays inside each stream's byte limit while the child writes", async () => {
  const result = await runOwnedProcess(process.execPath, ["-e", [
    "process.stdout.write(Buffer.alloc(512 * 1024, 97));",
    "process.stderr.write(Buffer.alloc(512 * 1024, 98));",
  ].join("")], { timeoutMs: 5_000, maxOutputBytes: 4_096 });

  assert.equal(result.code, 0);
  assert.equal(Buffer.byteLength(result.stdout), 4_096);
  assert.equal(Buffer.byteLength(result.stderr), 4_096);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
  assert.equal(result.timedOut, false);
  assert.match(result.stdout, /^a+$/);
  assert.match(result.stderr, /^b+$/);
});

test("owned process timeout terminates its POSIX process group and escalates", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX process groups are unavailable on Windows");
  const source = [
    "const { spawn } = require('node:child_process');",
    "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "process.stdout.write(JSON.stringify({ parent: process.pid, descendant: descendant.pid }));",
    "process.on('SIGTERM', () => {});",
    "setInterval(() => {}, 1000);",
  ].join("");

  const result = await runOwnedProcess(process.execPath, ["-e", source], {
    timeoutMs: 150,
    killGraceMs: 100,
    finalGraceMs: 500,
    maxOutputBytes: 4_096,
  });
  const pids = JSON.parse(result.stdout);

  assert.equal(result.code, null);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(processAlive(pids.parent), false);
  assert.equal(processAlive(pids.descendant), false);
});

test("owned process settles and releases pipes after a child never reports close", async () => {
  const child = new EventEmitter();
  child.pid = 43210;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.unrefCalls = 0;
  child.unref = () => { child.unrefCalls += 1; };
  const terminations = [];
  const run = createOwnedProcessRunner({
    spawnProcess: () => child,
    platform: "darwin",
    terminateTree: (_owned, force) => { terminations.push(force); },
  });

  const result = await run("fixture", [], {
    timeoutMs: 10,
    killGraceMs: 10,
    finalGraceMs: 10,
    maxOutputBytes: 4,
  });

  assert.deepEqual(terminations, [false, true]);
  assert.deepEqual(result, {
    code: null,
    signal: "SIGKILL",
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: true,
  });
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.equal(child.unrefCalls, 1);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.listenerCount("error"), 0);
});

test("Windows tree termination uses taskkill for the whole tree and force escalation", () => {
  const launches = [];
  const child = { pid: 9876, kill() { throw new Error("fallback should not run"); } };
  const spawnProcess = (command, args, options) => {
    launches.push({ command, args, options });
    const killer = new EventEmitter();
    killer.unref = () => {};
    return killer;
  };

  assert.equal(terminateProcessTree(child, { platform: "win32", spawnProcess }), true);
  assert.equal(terminateProcessTree(child, { platform: "win32", force: true, spawnProcess }), true);
  assert.deepEqual(launches.map(({ command, args }) => [command, args]), [
    ["taskkill.exe", ["/PID", "9876", "/T"]],
    ["taskkill.exe", ["/PID", "9876", "/T", "/F"]],
  ]);
  assert.equal(launches.every(({ options }) => options.windowsHide === true && options.stdio === "ignore"), true);
});
