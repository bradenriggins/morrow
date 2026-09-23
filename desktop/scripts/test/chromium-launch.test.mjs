import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { launchTestChromium } from "./lib/chromium-launch.mjs";

// A stand-in browser whose first starts never answer: it records its process id and waits. After
// `hangs` such starts it runs Playwright's own Chromium with the same arguments.
function stallingBrowser(directory, hangs) {
  const path = join(directory, "browser.sh");
  writeFileSync(path, [
    "#!/bin/sh",
    `count=$(cat ${JSON.stringify(join(directory, "starts"))} 2>/dev/null || echo 0)`,
    `echo $((count + 1)) > ${JSON.stringify(join(directory, "starts"))}`,
    `if [ "$count" -lt ${hangs} ]; then echo $$ >> ${JSON.stringify(join(directory, "stalled"))}; exec sleep 600; fi`,
    `exec ${JSON.stringify(chromium.executablePath())} "$@"`,
    "",
  ].join("\n"));
  chmodSync(path, 0o700);
  return path;
}

function stalledPids(directory) {
  return readFileSync(join(directory, "stalled"), "utf8").trim().split("\n").map(Number);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

const posixOnly = { skip: process.platform === "win32" ? "the stand-in browser is a POSIX shell script" : false };

test("a browser that never answers is ended at the start limit, and one fresh browser starts", posixOnly, async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-chromium-launch-"));
  let browser;
  try {
    browser = await launchTestChromium({ executablePath: stallingBrowser(directory, 1), startLimitMs: 1_000 });
    const page = await browser.newPage();
    await page.setContent("<p>started</p>");
    assert.equal(await page.textContent("p"), "started");
    const [stalled] = stalledPids(directory);
    assert.equal(alive(stalled), false, "the browser that never answered is still running");
  } finally {
    await browser?.close();
    for (const pid of (() => { try { return stalledPids(directory); } catch { return []; } })()) {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a second browser that never answers fails the launch, and neither is left running", posixOnly, async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-chromium-launch-"));
  try {
    await assert.rejects(
      launchTestChromium({ executablePath: stallingBrowser(directory, 2), startLimitMs: 1_000 }),
      (error) => error?.name === "TimeoutError",
    );
    const stalled = stalledPids(directory);
    assert.equal(stalled.length, 2);
    assert.deepEqual(stalled.filter(alive), [], "a browser that never answered is still running");
  } finally {
    for (const pid of (() => { try { return stalledPids(directory); } catch { return []; } })()) {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
