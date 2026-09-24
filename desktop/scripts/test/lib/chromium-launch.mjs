import { spawnSync } from "node:child_process";
import { chromium } from "playwright";

/**
 * Starts Playwright's own Chromium for a browser test, with a bound on a start that hangs.
 *
 * A start waits for the new browser to answer on its DevTools pipe. A normal start takes under two
 * seconds, even on a busy computer. A full check once saw a browser process start and never
 * answer, so Playwright waited its whole 180-second limit and then left that process running until
 * the test process exited. A start that has not answered within the limit here has hung: this
 * ends that browser and every process it started, then starts one fresh browser. A second hang
 * fails the test, with both browsers ended.
 */
export const CHROMIUM_START_LIMIT_MS = 30_000;

/** The process id Playwright records in its call log when it starts the browser. */
function startedPid(error) {
  const log = [String(error?.message || ""), ...(Array.isArray(error?.log) ? error.log : [])].join("\n");
  const match = /<launched> pid=(\d+)/.exec(log);
  return match ? Number(match[1]) : null;
}

function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function endHungBrowser(pid) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    // Playwright starts the browser as the leader of its own process group, so this also ends the
    // helper processes the browser started.
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
  while (running(pid)) await new Promise((resolve) => setTimeout(resolve, 20));
}

export async function launchTestChromium({ executablePath = chromium.executablePath(), startLimitMs = CHROMIUM_START_LIMIT_MS } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await chromium.launch({ headless: true, executablePath, timeout: startLimitMs });
    } catch (error) {
      if (error?.name !== "TimeoutError") throw error;
      const pid = startedPid(error);
      if (pid !== null) await endHungBrowser(pid);
      if (attempt >= 2) throw error;
      console.error(`[chromium-launch] Chromium did not answer within ${startLimitMs} ms and was ended. Starting a fresh browser.`);
    }
  }
}
