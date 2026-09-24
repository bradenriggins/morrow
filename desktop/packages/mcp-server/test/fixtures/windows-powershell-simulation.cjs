"use strict";

// Loaded with `node --require` into one Morrow process to run it as if on
// Windows: private-file-access takes its Windows branch, and every PowerShell
// the process starts is answered here instead of run. Each answered
// invocation is appended to MORROW_POWERSHELL_SIMULATION_LOG as one JSON line,
// so a test can count the PowerShell processes a Windows host would start.
// Every access-control answer is "private". Other processes run unchanged.

const childProcess = require("node:child_process");
const { appendFileSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");

const logPath = process.env.MORROW_POWERSHELL_SIMULATION_LOG;
if (!logPath) throw new Error("MORROW_POWERSHELL_SIMULATION_LOG is required");
Object.defineProperty(process, "platform", { value: "win32" });

const original = {
  spawn: childProcess.spawn,
  spawnSync: childProcess.spawnSync,
};

function record(entry) {
  appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), ...entry })}\n`, "utf8");
}

function isPowerShell(command) {
  return typeof command === "string" && /powershell(\.exe)?$/iu.test(command);
}

function scriptOf(args) {
  const list = Array.isArray(args) ? args : [];
  const encoded = list.indexOf("-EncodedCommand");
  if (encoded >= 0) return Buffer.from(String(list[encoded + 1] || ""), "base64").toString("utf16le");
  const command = list.indexOf("-Command");
  return command >= 0 ? String(list[command + 1] || "") : "";
}

function encodedPaths(script) {
  return [...script.matchAll(/FromBase64String\('([A-Za-z0-9+/=]*)'\)/gu)]
    .map((match) => Buffer.from(match[1], "base64").toString("utf16le"));
}

function batchPaths(script) {
  const list = /\$morrowTargets = @\(([^)]*)\)/u.exec(script);
  if (!list) return null;
  return [...list[1].matchAll(/'([A-Za-z0-9+/=]*)'/gu)].map((match) => Buffer.from(match[1], "base64").toString("utf16le"));
}

function processStartAnswer(script) {
  const pid = Number(/GetProcessById\((\d+)\)/u.exec(script)?.[1]);
  const result = original.spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  const startedAt = Date.parse(String(result.stdout || "").trim());
  return result.status === 0 && Number.isFinite(startedAt)
    ? { status: 0, stdout: `${new Date(startedAt).toISOString()}\n` }
    : { status: 1, stdout: "" };
}

/** Answers one PowerShell script the way a Windows host with private folders would. */
function answer(args) {
  const script = scriptOf(args);
  if (/GetProcessById\(/u.test(script)) {
    record({ kind: "process" });
    return processStartAnswer(script);
  }
  const batch = batchPaths(script);
  const applies = /SetAccessControl\(/u.test(script);
  if (batch) {
    record({ kind: applies ? "apply-and-check" : "check", paths: batch });
    return { status: 0, stdout: batch.map((_path, index) => `${index} private\n`).join("") };
  }
  if (applies) {
    record({ kind: "apply", paths: encodedPaths(script) });
    return { status: 0, stdout: "" };
  }
  record({ kind: "other" });
  return { status: 1, stdout: "" };
}

function syncResult(answered, options) {
  const text = options && options.encoding ? answered.stdout : Buffer.from(answered.stdout, "utf8");
  const empty = options && options.encoding ? "" : Buffer.alloc(0);
  return { pid: 0, output: [null, text, empty], stdout: text, stderr: empty, status: answered.status, signal: null };
}

childProcess.spawnSync = function simulatedSpawnSync(command, args, options) {
  if (isPowerShell(command)) return syncResult(answer(args), options);
  return original.spawnSync.apply(this, arguments);
};

childProcess.spawn = function simulatedSpawn(command, args, options) {
  if (isPowerShell(command)) {
    const answered = answer(args);
    const program = `process.stdout.write(${JSON.stringify(answered.stdout)}); process.exitCode = ${answered.status};`;
    return original.spawn.call(this, process.execPath, ["-e", program], { ...options, shell: false });
  }
  if (typeof command === "string" && /taskkill(\.exe)?$/iu.test(command)) {
    const list = Array.isArray(args) ? args : [];
    const pid = Number(list[list.indexOf("/PID") + 1]);
    const signal = list.includes("/F") ? "SIGKILL" : "SIGTERM";
    const program = `try { process.kill(-${pid}, ${JSON.stringify(signal)}); } catch { try { process.kill(${pid}, ${JSON.stringify(signal)}); } catch {} }`;
    return original.spawn.call(this, process.execPath, ["-e", program], { ...options, shell: false });
  }
  return original.spawn.apply(this, arguments);
};

syncBuiltinESMExports();
