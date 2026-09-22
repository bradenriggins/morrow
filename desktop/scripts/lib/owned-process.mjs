import { spawn } from "node:child_process";

const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;
const DEFAULT_KILL_GRACE_MS = 1_000;
const DEFAULT_FINAL_GRACE_MS = 1_000;

function positiveInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function outputCollector(maxBytes) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  return Object.freeze({
    append(chunk) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes >= maxBytes) {
        if (value.byteLength > 0) truncated = true;
        return;
      }
      const retained = Math.min(value.byteLength, maxBytes - bytes);
      if (retained > 0) {
        chunks.push(Buffer.from(value.subarray(0, retained)));
        bytes += retained;
      }
      if (retained < value.byteLength) truncated = true;
    },
    text() { return Buffer.concat(chunks, bytes).toString("utf8"); },
    truncated() { return truncated; },
  });
}

function fallbackKill(child, force) {
  try { return child.kill(force ? "SIGKILL" : undefined); } catch { return false; }
}

export function terminateProcessTree(child, { force = false, platform = process.platform, spawnProcess = spawn } = {}) {
  if (!Number.isSafeInteger(child?.pid) || child.pid < 1) return false;
  if (platform === "win32") {
    try {
      const killer = spawnProcess("taskkill.exe", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => { fallbackKill(child, force); });
      killer.unref?.();
      return true;
    } catch {
      return fallbackKill(child, force);
    }
  }
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
    return true;
  } catch {
    return fallbackKill(child, force);
  }
}

export function createOwnedProcessRunner(dependencies = {}) {
  const spawnProcess = dependencies.spawnProcess || spawn;
  const platform = dependencies.platform || process.platform;
  const terminateTree = dependencies.terminateTree
    || ((child, force) => terminateProcessTree(child, { force, platform }));

  return function runOwnedProcess(executable, argumentsValue, options = {}) {
    if (typeof executable !== "string" || executable.length === 0
      || !Array.isArray(argumentsValue) || argumentsValue.some((value) => typeof value !== "string")) {
      return Promise.reject(new TypeError("owned process command is invalid"));
    }
    const timeoutMs = positiveInteger(options.timeoutMs, "owned process timeout", 24 * 60 * 60 * 1_000);
    const killGraceMs = positiveInteger(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS, "owned process kill grace", 60_000);
    const finalGraceMs = positiveInteger(options.finalGraceMs ?? DEFAULT_FINAL_GRACE_MS, "owned process final grace", 60_000);
    const maxOutputBytes = positiveInteger(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, "owned process output limit", 16 * 1024 * 1024);
    const input = options.input ?? "ignore";
    if (input !== "ignore" && input !== "inherit") return Promise.reject(new TypeError("owned process input is invalid"));
    if (options.workingDirectory !== undefined && (typeof options.workingDirectory !== "string" || options.workingDirectory.length === 0)) {
      return Promise.reject(new TypeError("owned process working directory is invalid"));
    }
    if (options.onStdout !== undefined && typeof options.onStdout !== "function") return Promise.reject(new TypeError("owned process stdout observer is invalid"));
    if (options.onStderr !== undefined && typeof options.onStderr !== "function") return Promise.reject(new TypeError("owned process stderr observer is invalid"));

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnProcess(executable, argumentsValue, {
          ...(options.workingDirectory ? { cwd: options.workingDirectory } : {}),
          env: options.environment ?? process.env,
          stdio: [input, "pipe", "pipe"],
          detached: platform !== "win32",
          windowsHide: platform === "win32",
        });
      } catch (error) {
        reject(error);
        return;
      }

      const stdout = outputCollector(maxOutputBytes);
      const stderr = outputCollector(maxOutputBytes);
      let settled = false;
      let timedOut = false;
      let forced = false;
      let forceTimer = null;
      let finalTimer = null;

      let outputObserverError = null;
      const observe = (collector, observer, chunk) => {
        collector.append(chunk);
        if (!observer || outputObserverError) return;
        try { observer(chunk); } catch (error) { outputObserverError = error; }
      };
      const onStdout = (chunk) => observe(stdout, options.onStdout, chunk);
      const onStderr = (chunk) => observe(stderr, options.onStderr, chunk);
      const tearDownOutput = () => {
        child.stdout?.removeListener("data", onStdout);
        child.stderr?.removeListener("data", onStderr);
        child.stdout?.destroy();
        child.stderr?.destroy();
      };
      const clearTimers = () => {
        clearTimeout(timeoutTimer);
        clearTimeout(forceTimer);
        clearTimeout(finalTimer);
      };
      const result = (code, signal) => ({
        code: timedOut ? null : code,
        signal: timedOut ? (forced ? "SIGKILL" : "SIGTERM") : signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated(),
        stderrTruncated: stderr.truncated(),
        timedOut,
      });
      const finish = (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimers();
        child.removeListener("error", onError);
        child.removeListener("close", onClose);
        tearDownOutput();
        child.unref?.();
        if (outputObserverError) reject(outputObserverError);
        else resolve(result(code, signal));
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        child.removeListener("error", onError);
        child.removeListener("close", onClose);
        tearDownOutput();
        child.unref?.();
        reject(error);
      };
      function onError(error) {
        if (timedOut) finish(null, null);
        else fail(error);
      }
      function onClose(code, signal) { finish(code, signal); }

      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", onStderr);
      child.once("error", onError);
      child.once("close", onClose);
      const timeoutTimer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        try { terminateTree(child, false); } catch {}
        forceTimer = setTimeout(() => {
          if (settled) return;
          forced = true;
          try { terminateTree(child, true); } catch {}
          tearDownOutput();
          finalTimer = setTimeout(() => finish(null, null), finalGraceMs);
        }, killGraceMs);
      }, timeoutMs);
    });
  };
}

export const runOwnedProcess = createOwnedProcessRunner();
