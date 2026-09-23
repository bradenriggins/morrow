"use strict";

// Loaded with `node --require` into a Claude Desktop launcher a test starts.
// The launcher then proves its Claude process as it does on Windows, and a
// stand-in for PowerShell answers as MORROW_TEST_CLAUDE_PROOF says:
//   gate:<path>        the proof, once <path> exists
//   delay:<ms>         the proof, after <ms> milliseconds
//   hang               nothing, ever
//   malformed          text that is not JSON
//   wrong-shape        JSON that is not a Claude process proof
//   malformed-then-proof  malformed on the first question, the proof after
// Each question adds a line to MORROW_TEST_CLAUDE_PROOF_LOG. Every other
// process runs unchanged, except taskkill, which is answered with a signal.

const childProcess = require("node:child_process");
const { appendFileSync, readFileSync } = require("node:fs");

const mode = String(process.env.MORROW_TEST_CLAUDE_PROOF || "");
const logPath = process.env.MORROW_TEST_CLAUDE_PROOF_LOG;
if (!mode || !logPath) throw new Error("MORROW_TEST_CLAUDE_PROOF and MORROW_TEST_CLAUDE_PROOF_LOG are required");
Object.defineProperty(process, "platform", { value: "win32" });

const PROOF = JSON.stringify({
  platform: "win32",
  processId: 4242,
  executablePath: "C:\\Program Files\\Claude\\Claude.exe",
  signerThumbprint: "A".repeat(40),
});
const originalSpawn = childProcess.spawn;

function questionNumber() {
  appendFileSync(logPath, "question\n", "utf8");
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean).length;
}

function answerProgram(question) {
  const print = (text) => `process.stdout.write(${JSON.stringify(text)});`;
  if (mode.startsWith("gate:")) {
    const gate = JSON.stringify(mode.slice("gate:".length));
    return `const fs = require("node:fs"); const wait = setInterval(() => { if (!fs.existsSync(${gate})) return; clearInterval(wait); ${print(`${PROOF}\n`)} }, 10);`;
  }
  if (mode.startsWith("delay:")) return `setTimeout(() => { ${print(`${PROOF}\n`)} }, ${Number(mode.slice("delay:".length))});`;
  if (mode === "hang") return "setInterval(() => {}, 1000);";
  if (mode === "malformed") return print("not a proof\n");
  if (mode === "wrong-shape") return print('{"platform":"win32","processId":"4242"}\n');
  if (mode === "malformed-then-proof") return print(question === 1 ? "not a proof\n" : `${PROOF}\n`);
  throw new Error(`unknown proof mode ${mode}`);
}

childProcess.spawn = function simulatedSpawn(command, args, options) {
  if (typeof command === "string" && /powershell(\.exe)?$/iu.test(command)) {
    return originalSpawn.call(this, process.execPath, ["-e", answerProgram(questionNumber())], { ...options, shell: false });
  }
  if (typeof command === "string" && /taskkill(\.exe)?$/iu.test(command)) {
    const list = Array.isArray(args) ? args : [];
    const pid = Number(list[list.indexOf("/PID") + 1]);
    const signal = list.includes("/F") ? "SIGKILL" : "SIGTERM";
    return originalSpawn.call(this, process.execPath, ["-e", `try { process.kill(${pid}, ${JSON.stringify(signal)}); } catch {}`], { ...options, shell: false });
  }
  return originalSpawn.apply(this, arguments);
};
