#!/usr/bin/env node

/**
 * First-use browser proof for the Morrow for Muse sign-in helper.
 *
 * Runs the real `morrow-for-muse/helper/server.py` (its own main(), token file, rate limiter and
 * input dispatch) with the Playwright-managed Chrome for Testing as the helper's headless browser.
 * The helper's tenant is a local synthetic sign-in site that reports every event it receives, so
 * each check reads back what reached the remote page, not only what the helper UI shows. The helper
 * UI is then opened in a second Chrome for Testing page through a single-use sign-in link.
 *
 * Covered: screenshot rendering, visible HTTP and transport errors with recovery, the missing-link
 * notice, keyboard capture with Escape release and re-entry, wheel and touch scrolling with scaled
 * coordinates, click and tap scaling, input bounds, input authorization, client wheel coalescing,
 * and the server rate limit.
 *
 * Usage: node scripts/test/muse-helper-first-use.mjs [--artifacts <dir>]
 * Writes screenshots, the helper log and receipt.json to the artifact folder. Exit 1 on any failed
 * check. No real school, account, live helper port or installed Morrow is touched.
 */

import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { launchManagedChromiumPersistentContext } from "../lib/playwright-managed-browser.mjs";

const DESKTOP = resolve(import.meta.dirname, "../..");
const REPO = resolve(DESKTOP, "..");
const MUSE = join(REPO, "morrow-for-muse");
const HELPER = join(MUSE, "helper");
// The helper's browser window (server.py VIEWPORT). Headless Chromium's page viewport is this width
// and at most this height; the input bounds are the window.
const REMOTE_WINDOW = { width: 1600, height: 1000 };
const SIGNIN_TOP = 1700;

const argv = process.argv.slice(2);
const artifactFlag = argv.indexOf("--artifacts");
const temporary = mkdtempSync(join(tmpdir(), "morrow-muse-helper-e2e-"));
const artifacts = artifactFlag >= 0 ? resolve(argv[artifactFlag + 1]) : join(temporary, "artifacts");
mkdirSync(artifacts, { recursive: true });

const checks = [];
function check(name, ok, detail = undefined) {
  checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  process.stderr.write(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}\n`);
  return Boolean(ok);
}

async function freePort() {
  const probe = createServer();
  await new Promise((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

async function until(predicate, timeoutMs = 8000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await delay(stepMs);
  }
}

// ---------------------------------------------------------------------------
// Synthetic school sign-in site (the helper's tenant). Every event the helper's
// browser delivers is reported back here.
// ---------------------------------------------------------------------------

const remoteEvents = [];
const SIGNIN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Example School sign-in</title>
<style>
  html,body{margin:0;background:#ffffff;font:18px system-ui,sans-serif}
  #brand{position:absolute;left:0;top:0;width:100%;height:80px;background:#1e7d32;color:#fff;font-size:28px;line-height:80px;padding-left:24px;box-sizing:border-box}
  input{position:absolute;left:100px;width:400px;height:40px;font-size:18px;box-sizing:border-box}
  #u{top:200px} #p{top:280px}
  button{position:absolute;left:100px;width:300px;height:60px;font-size:20px}
  #tap{top:400px;background:#ffd54f} #signin{top:${SIGNIN_TOP}px;background:#1565c0;color:#fff}
  #spacer{position:absolute;top:2500px;height:100px;width:10px}
</style></head><body>
<div id="brand">Example School sign-in</div>
<input id="u" aria-label="Username" autocomplete="off"><input id="p" type="password" aria-label="Password">
<button id="tap">Continue with school account</button>
<button id="signin">Sign in</button><div id="spacer"></div>
<script>
  const send = (e) => fetch("/__event", {method: "POST", body: JSON.stringify(e), keepalive: true});
  addEventListener("focusin", (e) => send({type: "focus", id: e.target.id || e.target.tagName}));
  addEventListener("keydown", (e) => send({type: "keydown", key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey}));
  addEventListener("keyup", (e) => send({type: "keyup", key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey}));
  addEventListener("input", (e) => send({type: "input", id: e.target.id, value: e.target.value}));
  addEventListener("click", (e) => send({type: "click", id: e.target.id || e.target.tagName, clientX: e.clientX, clientY: e.clientY}));
  addEventListener("wheel", (e) => send({type: "wheel", deltaY: e.deltaY, clientX: e.clientX, clientY: e.clientY}), {passive: true});
  let pending = null;
  addEventListener("scroll", () => { clearTimeout(pending); pending = setTimeout(() => send({type: "scroll", scrollY: Math.round(scrollY)}), 60); });
  send({type: "loaded", width: innerWidth, height: innerHeight});
</script></body></html>`;

// A throwaway self-signed certificate for localhost. The helper trusts it only through the product's
// own egress CA pin (MORROW_EGRESS_CA_PEM -> --ignore-certificate-errors-spki-list), the same path a
// Muse VM uses for its egress CA; the helper navigates only to https tenants.
const siteKey = join(temporary, "site-key.pem");
const siteCert = join(temporary, "site-cert.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", siteKey, "-out", siteCert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
const site = createHttpsServer({ key: readFileSync(siteKey), cert: readFileSync(siteCert) }, (req, res) => {
  if (req.method === "POST" && req.url === "/__event") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { remoteEvents.push({ at: Date.now(), ...JSON.parse(body) }); } catch {}
      res.end("ok");
    });
    return;
  }
  if (req.url === "/" || req.url?.startsWith("/?")) {
    res.writeHead(302, { Location: "/login/canvas" });
    res.end();
    return;
  }
  if (req.url === "/login/canvas") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(SIGNIN_PAGE);
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((done) => site.listen(0, "127.0.0.1", done));
const sitePort = site.address().port;

const remote = {
  count: (predicate) => remoteEvents.filter(predicate).length,
  last: (predicate) => [...remoteEvents].reverse().find(predicate),
  scrollY: () => remoteEvents.filter((e) => e.type === "scroll").at(-1)?.scrollY ?? 0,
  mark: () => remoteEvents.length,
  since: (mark, predicate) => remoteEvents.slice(mark).filter(predicate),
};

// ---------------------------------------------------------------------------
// The real helper server.
// ---------------------------------------------------------------------------

const helperPort = await freePort();
const cdpLabel = 19400 + (helperPort % 1000);
const home = join(temporary, "home");
const profileDir = join(temporary, "helper-profile");
mkdirSync(home, { recursive: true });
const token = randomBytes(32).toString("hex");
const tokenFile = join(temporary, "helper_token");
writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
const chromeForTesting = chromium.executablePath();
// The helper's version gate accepts only a "Chromium"/"Google Chrome" banner. This wrapper reports
// the managed Chrome for Testing version under the Chromium name and execs the same binary for every
// launch, so the helper still runs and identifies the real browser process. --use-mock-keychain keeps
// a fresh macOS profile from blocking on the login keychain; the Muse VM is Linux and has no keychain.
const chromeWrapper = join(temporary, "chromium");
const chromeVersionNumber = execFileSync(chromeForTesting, ["--version"], { encoding: "utf8" }).trim().split(/\s+/).at(-1);
writeFileSync(chromeWrapper, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Chromium ${chromeVersionNumber}"; exit 0; fi\nexec "${chromeForTesting}" --use-mock-keychain "$@"\n`, { mode: 0o755 });
const helperLog = join(artifacts, "helper-server.log");
const helperLogStream = createWriteStream(helperLog, { flags: "a" });

function helperEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(https?_proxy|HTTPS?_PROXY|no_proxy|NO_PROXY|CANVAS_BASE.*|LOGIN_HELPER_.*|HELPER_AUTH_.*|MORROW_.*)$/.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    MORROW_HOME: join(home, ".morrow"),
    MORROW_HELPER_ENV_FILE: join(temporary, "helper-env-absent"),
    PYTHONDONTWRITEBYTECODE: "1",
    CANVAS_BASE: `https://localhost:${sitePort}`,
    CANVAS_BASE_CUSTOM_DOMAIN_CONFIRMED: "localhost",
    MORROW_EGRESS_CA_PEM: siteCert,
    CHROMIUM_BIN: chromeWrapper,
    LOGIN_HELPER_PORT: String(helperPort),
    LOGIN_HELPER_CDP_PORT: String(cdpLabel),
    LOGIN_HELPER_PROFILE_DIR: profileDir,
    HELPER_AUTH_TOKEN_FILE: tokenFile,
    // Unauthenticated-proxy egress mode: the helper launches Chromium with --proxy-server and no
    // forwarder, and Chromium reaches the loopback sign-in site directly (loopback bypasses proxies).
    // Nothing listens on port 9, so no request can leave this machine.
    https_proxy: "http://127.0.0.1:9",
  };
}

let helperProcess = null;
async function startHelper() {
  helperProcess = spawn("python3", [join(HELPER, "server.py")], { cwd: HELPER, env: helperEnv(), stdio: ["ignore", "pipe", "pipe"] });
  helperProcess.stdout.pipe(helperLogStream, { end: false });
  helperProcess.stderr.pipe(helperLogStream, { end: false });
  const up = await until(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${helperPort}/status`, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) return false;
      const status = await response.json();
      return status.chromium_alive !== false && String(status.url || "").includes("/login/canvas") ? status : false;
    } catch {
      return false;
    }
  }, 60_000, 250);
  return up;
}
async function stopHelper() {
  if (!helperProcess || helperProcess.exitCode !== null) return;
  const exited = new Promise((done) => helperProcess.once("exit", done));
  helperProcess.kill("SIGTERM");
  await Promise.race([exited, delay(15_000)]);
  if (helperProcess.exitCode === null) helperProcess.kill("SIGKILL");
}
function helperChromiumPids() {
  try {
    return execFileSync("pgrep", ["-f", `user-data-dir=${profileDir}`], { encoding: "utf8" }).split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

async function helperFetch(path, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:${helperPort}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    body,
  });
  const text = await response.text();
  return { status: response.status, text, retryAfter: response.headers.get("retry-after") };
}
const AUTH = { "X-Helper-Token": token };

async function mintSignInLink() {
  const minted = await helperFetch("/page-code", { method: "POST", body: "{}", headers: AUTH });
  let code = "";
  try { code = JSON.parse(minted.text).page_code || ""; } catch {}
  check("POST /page-code with the launch token mints a single-use code", minted.status === 200 && /^[0-9a-f]{32}$/.test(code), minted.status);
  return code ? `http://127.0.0.1:${helperPort}/?code=${code}` : `http://127.0.0.1:${helperPort}/`;
}

// ---------------------------------------------------------------------------
// Helper UI readers.
// ---------------------------------------------------------------------------

async function uiState(page) {
  return await page.evaluate(() => {
    const img = document.getElementById("screen");
    const err = document.getElementById("err");
    const nolink = document.getElementById("nolink");
    const visible = (element) => Boolean(element) && getComputedStyle(element).display !== "none" && element.getBoundingClientRect().height > 0;
    return {
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      src: img.getAttribute("src") || "",
      errorVisible: visible(err),
      errorText: err ? err.textContent : "",
      nolinkVisible: visible(nolink),
      badge: document.getElementById("badge").textContent,
      active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : "",
    };
  });
}

async function remotePixel(page, x, y) {
  return await page.evaluate(([px, py]) => {
    const img = document.getElementById("screen");
    if (!img.naturalWidth) return null;
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(img, 0, 0);
    return Array.from(context.getImageData(px, py, 1, 1).data.slice(0, 3));
  }, [x, y]);
}

async function displayPoint(page, remoteX, remoteY) {
  return await page.evaluate(([rx, ry]) => {
    const rect = document.getElementById("screen").getBoundingClientRect();
    const img = document.getElementById("screen");
    return { x: rect.left + rx * (rect.width / img.naturalWidth), y: rect.top + ry * (rect.height / img.naturalHeight), scale: img.naturalWidth / rect.width };
  }, [remoteX, remoteY]);
}

const nearGreen = (rgb) => Array.isArray(rgb) && Math.abs(rgb[0] - 0x1e) < 24 && Math.abs(rgb[1] - 0x7d) < 24 && Math.abs(rgb[2] - 0x32) < 24;

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------

let context;
let exitCode = 1;
const pageErrors = [];
const startedAt = new Date().toISOString();
try {
  const firstStatus = await startHelper();
  check("real helper server starts with Chrome for Testing and lands on the sign-in page", firstStatus, firstStatus);
  if (!firstStatus) throw new Error("helper_not_started");

  context = await launchManagedChromiumPersistentContext(chromium, join(temporary, "ui-profile"), {
    headless: true,
    viewport: { width: 1000, height: 900 },
    hasTouch: true,
  });

  // --- Missing or spent sign-in link -------------------------------------------------------
  const bare = await context.newPage();
  bare.on("pageerror", (error) => pageErrors.push(`bare: ${error.message}`));
  const bareScreenshots = [];
  bare.on("request", (request) => { if (new URL(request.url()).pathname === "/screenshot") bareScreenshots.push(request.url()); });
  await bare.goto(`http://127.0.0.1:${helperPort}/`);
  await delay(1500);
  const bareState = await uiState(bare);
  check("bare helper address shows the missing-link notice", bareState.nolinkVisible, bareState);
  check("bare helper address sends no screenshot requests without a token", bareScreenshots.length === 0, bareScreenshots.length);
  const bareControls = await bare.evaluate(() => ["stage", "capture"].map((id) => {
    const element = document.getElementById(id);
    return { id, visible: Boolean(element) && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden" };
  }));
  check("bare helper address hides the page stage and keyboard controls it cannot drive", bareControls.every((control) => !control.visible), bareControls);
  const bareHtml = (await helperFetch("/")).text;
  check("bare GET / carries no launch token", !bareHtml.includes(token) && !bareHtml.includes("__HELPER_TOKEN__"));
  await bare.screenshot({ path: join(artifacts, "ui-missing-link.png"), fullPage: true });
  await bare.close();

  // --- Successful first load through a one-time link ---------------------------------------
  const link = await mintSignInLink();
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(`ui: ${error.message}`));
  const uiRequests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    uiRequests.push({ at: Date.now(), method: request.method(), path: url.pathname });
  });
  await page.goto(link);
  const rendered = await until(async () => {
    const state = await uiState(page);
    return state.naturalWidth > 0 ? state : false;
  }, 8000);
  const loadedState = await uiState(page);
  check("screenshot renders in the helper page", loadedState.naturalWidth === REMOTE_WINDOW.width && loadedState.naturalHeight > 600 && loadedState.naturalHeight <= REMOTE_WINDOW.height, loadedState);
  const remoteHeight = loadedState.naturalHeight;
  check("rendered screenshot is the school sign-in page", nearGreen(await remotePixel(page, 20, 20)), await remotePixel(page, 20, 20));
  check("no error is shown on a healthy helper", !loadedState.errorVisible, loadedState.errorText);
  check("a used one-time link injects no token on reuse", !(await helperFetch(new URL(link).pathname + new URL(link).search)).text.includes(token));
  await page.screenshot({ path: join(artifacts, "ui-first-load.png"), fullPage: true });
  void rendered;

  // --- Scaled click and keyboard capture ---------------------------------------------------
  const usernamePoint = await displayPoint(page, 300, 220);
  check("the helper page scales the remote viewport down", usernamePoint.scale > 1.2, usernamePoint);
  let mark = remote.mark();
  await page.mouse.click(usernamePoint.x, usernamePoint.y);
  const usernameClick = await until(() => remote.since(mark, (e) => e.type === "click").at(-1), 5000);
  check("a displayed click lands on the scaled remote point", usernameClick && Math.abs(usernameClick.clientX - 300) <= 3 && Math.abs(usernameClick.clientY - 220) <= 3, usernameClick);
  check("the click focuses the remote username field", await until(() => remote.since(mark, (e) => e.type === "focus" && e.id === "u").length > 0, 3000));
  check("clicking the page puts keyboard capture on the stage", (await uiState(page)).active === "stage", (await uiState(page)).active);

  await page.keyboard.type("teacher", { delay: 40 });
  check("typed text reaches the remote field", await until(() => remote.last((e) => e.type === "input" && e.id === "u")?.value === "teacher", 5000), remote.last((e) => e.type === "input"));

  mark = remote.mark();
  await page.keyboard.press("Tab");
  check("Tab inside capture moves focus in the remote page", await until(() => remote.since(mark, (e) => e.type === "focus" && e.id === "p").length > 0, 5000), remote.since(mark, () => true));
  check("Tab inside capture keeps keyboard capture on the stage", (await uiState(page)).active === "stage", (await uiState(page)).active);

  mark = remote.mark();
  await page.keyboard.press("Escape");
  await delay(400);
  const released = await uiState(page);
  check("Escape releases keyboard capture", released.active !== "stage" && released.active !== "BODY", released.active);
  check("Escape is not sent to the remote page", remote.since(mark, (e) => e.type === "keydown" && e.key === "Escape").length === 0);
  await page.screenshot({ path: join(artifacts, "ui-keyboard-released.png"), fullPage: true });
  await page.keyboard.press("Tab");
  const afterTab = await page.evaluate(() => ({ tag: document.activeElement?.tagName, href: document.activeElement?.getAttribute("href") }));
  check("Tab after release reaches the footer link", afterTab.tag === "A" && afterTab.href === "https://meetmorrow.app", afterTab);
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  const reentered = await uiState(page);
  check("Shift+Tab returns to the stage and captures again", reentered.active === "stage", reentered.active);
  mark = remote.mark();
  await page.keyboard.type("pw", { delay: 40 });
  check("typing after re-entry reaches the remote page", await until(() => remote.last((e) => e.type === "input" && e.id === "p")?.value === "pw", 5000), remote.since(mark, () => true));
  const described = await page.evaluate(() => {
    const stage = document.getElementById("stage");
    const ids = (stage.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    return ids.map((id) => document.getElementById(id)?.textContent || "").join(" ");
  });
  check("the stage describes how to leave keyboard capture", /\bEsc(ape)?\b/.test(described), described);

  mark = remote.mark();
  await page.keyboard.press("Shift+Tab");
  check("Shift+Tab moves backward on the remote sign-in page", await until(() => remote.since(mark, (e) => e.type === "focus" && e.id === "u").length > 0, 3000), remote.since(mark, () => true));

  for (const [key, code, keyCode] of [["Shift", "ShiftLeft", 16], ["Control", "ControlLeft", 17], ["Alt", "AltLeft", 18], ["Meta", "MetaLeft", 91]]) {
    for (const exit of ["Escape", "blur"]) {
      await page.locator("#capture").click();
      mark = remote.mark();
      await page.keyboard.down(key);
      await until(() => remote.since(mark, (e) => e.type === "keydown" && e.key === key).length > 0, 3000);
      if (exit === "Escape") await page.keyboard.press("Escape");
      else await page.locator('a[href="https://meetmorrow.app"]').focus();
      await page.keyboard.up(key);
      check(`${key} is released remotely when capture ends by ${exit}`, await until(() => remote.since(mark, (e) => e.type === "keyup" && e.key === key).length > 0, 3000), remote.since(mark, () => true));
      // Clear a failed fixture's remote modifier before the next independent scenario.
      await helperFetch("/input/key", { method: "POST", headers: AUTH, body: JSON.stringify({ kind: "up", key, code, keyCode, modifiers: 0 }) });
    }
  }
  await page.route("**/screenshot", (route) => route.fulfill({ status: 200, contentType: "image/png", body: "not a valid image" }));
  check("invalid HTTP 200 image data shows a visible recovery step", await until(async () => (await uiState(page)).errorVisible, 6000), await uiState(page));
  await page.screenshot({ path: join(artifacts, "ui-invalid-image.png"), fullPage: true });
  await page.unroute("**/screenshot");
  check("valid images clear the decode error and restore the remote view", await until(async () => {
    const state = await uiState(page);
    return !state.errorVisible && state.naturalWidth === REMOTE_WINDOW.width;
  }, 6000), await uiState(page));

  // --- Wheel scrolling ------------------------------------------------------------------------
  const center = await displayPoint(page, 800, 500);
  await page.mouse.move(center.x, center.y);
  const wheelPostsBefore = uiRequests.filter((r) => r.path === "/input/wheel").length;
  mark = remote.mark();
  const burstStart = Date.now();
  // 200 small steps (about 1300 remote px) leave the Sign in button inside the remote viewport.
  for (let i = 0; i < 200; i += 1) await page.mouse.wheel(0, 4);
  const burstMs = Date.now() - burstStart;
  const signinVisibleFrom = SIGNIN_TOP + 60 - remoteHeight;
  const scrolled = await until(() => remote.scrollY() >= signinVisibleFrom, 8000);
  check("wheel over the helper page scrolls the remote page", scrolled, remote.scrollY());
  const wheelPosts = uiRequests.filter((r) => r.path === "/input/wheel").length - wheelPostsBefore;
  const wheelBudget = Math.ceil((burstMs + 1500) / 100) + 2;
  check("a wheel burst is coalesced before it reaches the helper", wheelPosts > 0 && wheelPosts <= wheelBudget, { wheelPosts, burstMs, wheelBudget });
  const remoteWheel = remote.since(mark, (e) => e.type === "wheel");
  check("remote wheel events arrive at the scaled pointer position", remoteWheel.length > 0 && remoteWheel.every((e) => Math.abs(e.clientX - 800) <= 3 && Math.abs(e.clientY - 500) <= 3), remoteWheel.slice(0, 3));
  await delay(1200);
  await page.screenshot({ path: join(artifacts, "ui-after-wheel.png"), fullPage: true });
  const signinY = SIGNIN_TOP - remote.scrollY() + 30;
  check("the Sign in button is inside the remote viewport after scrolling", signinY > 0 && signinY < remoteHeight, { scrollY: remote.scrollY(), signinY });
  const signinPoint = await displayPoint(page, 250, signinY);
  mark = remote.mark();
  await page.mouse.click(signinPoint.x, signinPoint.y);
  check("the control below the first viewport is reachable after scrolling", await until(() => remote.since(mark, (e) => e.type === "click" && e.id === "signin").length > 0, 5000), remote.since(mark, () => true));

  // --- Touch: swipe scrolls, tap clicks -----------------------------------------------------------
  const touch = await page.context().newCDPSession(page);
  const swipeStart = await displayPoint(page, 800, 300);
  const before = remote.scrollY();
  mark = remote.mark();
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: swipeStart.x, y: swipeStart.y }] });
  for (let step = 1; step <= 12; step += 1) {
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: swipeStart.x, y: swipeStart.y + step * 25 }] });
    await delay(16);
  }
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const swipedUp = await until(() => remote.scrollY() <= before - 300, 6000);
  check("a one-finger swipe scrolls the remote page", swipedUp, { before, after: remote.scrollY() });
  check("a swipe does not click the remote page", remote.since(mark, (e) => e.type === "click").length === 0, remote.since(mark, (e) => e.type === "click"));
  await page.mouse.move(center.x, center.y);
  for (let i = 0; i < 20; i += 1) await page.mouse.wheel(0, -400);
  const atTop = await until(async () => {
    await delay(300);
    return remote.scrollY() === 0;
  }, 8000);
  check("wheel scrolls the remote page back to the top", atTop, remote.scrollY());
  await delay(800);
  const tapPoint = await displayPoint(page, 250, 430);
  mark = remote.mark();
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: tapPoint.x, y: tapPoint.y }] });
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const tap = await until(() => remote.since(mark, (e) => e.type === "click").at(-1), 5000);
  check("a tap clicks the scaled remote point", tap && tap.id === "tap" && Math.abs(tap.clientX - 250) <= 3 && Math.abs(tap.clientY - 430) <= 3, tap);
  await page.screenshot({ path: join(artifacts, "ui-after-touch.png"), fullPage: true });

  // --- Input contract: bounds and authorization ---------------------------------------------------
  mark = remote.mark();
  const bad = [
    ["non-finite x", '{"x": NaN, "y": 10, "deltaX": 0, "deltaY": 50}'],
    ["infinite delta", '{"x": 10, "y": 10, "deltaX": 0, "deltaY": Infinity}'],
    ["negative x", '{"x": -1, "y": 10, "deltaX": 0, "deltaY": 50}'],
    ["x past the viewport", `{"x": ${REMOTE_WINDOW.width}, "y": 10, "deltaX": 0, "deltaY": 50}`],
    ["y past the viewport", `{"x": 10, "y": ${REMOTE_WINDOW.height + 5}, "deltaX": 0, "deltaY": 50}`],
    ["absurd delta", '{"x": 10, "y": 10, "deltaX": 0, "deltaY": 100000}'],
    ["text coordinate", '{"x": "10", "y": 10, "deltaX": 0, "deltaY": 50}'],
    ["boolean coordinate", '{"x": true, "y": 10, "deltaX": 0, "deltaY": 50}'],
    ["missing delta", '{"x": 10, "y": 10}'],
  ];
  const badResults = [];
  for (const [label, body] of bad) badResults.push({ label, status: (await helperFetch("/input/wheel", { method: "POST", body, headers: AUTH })).status });
  check("malformed or out-of-bounds wheel input is refused with 400", badResults.every((r) => r.status === 400), badResults);
  const badMouse = [];
  for (const body of ['{"kind": "pressed", "x": -4, "y": 10}', `{"kind": "moved", "x": 10, "y": ${REMOTE_WINDOW.height}}`, '{"kind": "pressed", "x": NaN, "y": 1}', '{"kind": "pressed", "x": "a", "y": 1}']) {
    badMouse.push((await helperFetch("/input/mouse", { method: "POST", body, headers: AUTH })).status);
  }
  check("out-of-bounds or malformed mouse input is refused with 400", badMouse.every((status) => status === 400), badMouse);
  const badKeys = [];
  for (const modifiers of [-1, 16, 1.5, "8", true, null]) {
    badKeys.push((await helperFetch("/input/key", { method: "POST", headers: AUTH, body: JSON.stringify({ kind: "down", key: "Tab", code: "Tab", keyCode: 9, modifiers }) })).status);
  }
  check("invalid keyboard modifier masks are refused with 400", badKeys.every((status) => status === 400), badKeys);
  const unauthenticated = (await helperFetch("/input/wheel", { method: "POST", body: '{"x": 10, "y": 10, "deltaX": 0, "deltaY": 50}' })).status;
  const wrongToken = (await helperFetch("/input/wheel", { method: "POST", body: '{"x": 10, "y": 10, "deltaX": 0, "deltaY": 50}', headers: { "X-Helper-Token": "0".repeat(64) } })).status;
  check("wheel input without the launch token is refused", unauthenticated === 403 && wrongToken === 403, { unauthenticated, wrongToken });
  await delay(600);
  check("refused input never reaches the remote page", remote.since(mark, (e) => e.type === "wheel" || e.type === "click" || e.type === "scroll").length === 0, remote.since(mark, () => true));
  const accepted = await helperFetch("/input/wheel", { method: "POST", body: `{"x": ${REMOTE_WINDOW.width - 1}, "y": ${remoteHeight - 1}, "deltaX": 0, "deltaY": 5000}`, headers: AUTH });
  check("wheel input at the viewport edge with the bounded delta is accepted", accepted.status === 200, accepted);
  check("accepted wheel input reaches the remote page", await until(() => remote.since(mark, (e) => e.type === "wheel").length > 0, 4000));

  // --- HTTP error from the helper, then transport loss and recovery ---------------------------------
  for (const pid of helperChromiumPids()) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  const httpError = await until(async () => {
    const state = await uiState(page);
    return state.errorVisible && /HTTP 5\d\d/.test(state.errorText) ? state : false;
  }, 10_000);
  check("a helper HTTP error is shown with its status and a next step", httpError && /(restart|wait|keep this page open|try again)/i.test(httpError.errorText), await uiState(page));
  await page.screenshot({ path: join(artifacts, "ui-http-error.png"), fullPage: true });

  await stopHelper();
  const transportError = await until(async () => {
    const state = await uiState(page);
    return state.errorVisible && /(cannot reach|can.t reach|not reachable|unreachable)/i.test(state.errorText) ? state : false;
  }, 10_000);
  check("losing the helper connection is shown as a transport error", transportError, await uiState(page));
  await page.screenshot({ path: join(artifacts, "ui-transport-error.png"), fullPage: true });
  const errorNodeStable = await page.evaluate(async () => {
    const err = document.getElementById("err");
    const first = err.firstChild;
    await new Promise((done) => setTimeout(done, 1500));
    return err.firstChild === first;
  });
  check("a repeated identical error is not re-announced", errorNodeStable);

  const staleSource = (await uiState(page)).src;
  const restarted = await startHelper();
  check("the helper restarts with the same token file", restarted, restarted);
  const recovered = await until(async () => {
    const state = await uiState(page);
    return !state.errorVisible && state.naturalWidth === REMOTE_WINDOW.width && state.src !== staleSource ? state : false;
  }, 15_000);
  check("the helper page recovers and clears the error after the helper returns", recovered, await uiState(page));
  await page.screenshot({ path: join(artifacts, "ui-recovered.png"), fullPage: true });

  // --- Server rate limit and the page's response to it -----------------------------------------------
  // Eight at a time stays under the helper's 16-thread cap, so the answers come from its rate limiter.
  // After the first 429 the flood continues for two seconds while the page keeps polling.
  const flood = [];
  const floodBatch = async () => flood.push(...await Promise.all(Array.from({ length: 8 }, () => helperFetch("/input/mouse", { method: "POST", body: '{"kind": "moved", "x": 5, "y": 5}', headers: AUTH }))));
  for (let sent = 0; sent < 320 && !flood.some((r) => r.status === 429); sent += 8) await floodBatch();
  const busyWatch = until(async () => {
    const state = await uiState(page);
    return state.errorVisible && /(busy|too many|slow)/i.test(state.errorText) ? state : false;
  }, 4000, 50);
  const floodUntil = Date.now() + 2000;
  while (Date.now() < floodUntil) await floodBatch();
  const busy = await busyWatch;
  const limited = flood.filter((r) => r.status === 429);
  check("the helper rate limit answers 429 with Retry-After past its budget", limited.length > 0 && limited.every((r) => r.retryAfter === "1"), { limited: limited.length, statuses: [...new Set(flood.map((r) => r.status))] });
  check("the helper page explains a rate-limited screenshot", busy, await uiState(page));
  await page.screenshot({ path: join(artifacts, "ui-rate-limited.png"), fullPage: true });
  const settled = await until(async () => !(await uiState(page)).errorVisible, 15_000);
  check("the helper page resumes after the rate limit window", settled, await uiState(page));

  check("the helper page raised no script errors", pageErrors.length === 0, pageErrors);
  exitCode = checks.every((c) => c.ok) ? 0 : 1;
} catch (error) {
  check("harness completed", false, String(error?.stack || error));
  exitCode = 1;
} finally {
  try { await context?.close(); } catch {}
  await stopHelper();
  await new Promise((done) => site.close(done));
  helperLogStream.end();
  const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  let chromeVersion = "";
  try { chromeVersion = execFileSync(chromeForTesting, ["--version"], { encoding: "utf8" }).trim(); } catch {}
  let revision = "";
  try { revision = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch {}
  let dirty = "";
  try { dirty = execFileSync("git", ["-C", REPO, "status", "--porcelain", "--", "morrow-for-muse/helper"], { encoding: "utf8" }).trim(); } catch {}
  const receipt = {
    schema: "morrow.muse.helper-first-use.v1",
    startedAt,
    finishedAt: new Date().toISOString(),
    host: execFileSync("hostname", { encoding: "utf8" }).trim(),
    repository: { revision, helperWorkingTreeChanges: dirty ? dirty.split("\n") : [] },
    browser: chromeVersion,
    inputs: {
      "helper/index.html": sha256(join(HELPER, "index.html")),
      "helper/server.py": sha256(join(HELPER, "server.py")),
    },
    passed: checks.filter((c) => c.ok).length,
    failed: checks.filter((c) => !c.ok).length,
    checks,
    artifacts: ["ui-missing-link.png", "ui-first-load.png", "ui-keyboard-released.png", "ui-after-wheel.png", "ui-after-touch.png", "ui-http-error.png", "ui-transport-error.png", "ui-recovered.png", "ui-rate-limited.png", "helper-server.log"],
  };
  writeFileSync(join(artifacts, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  process.stderr.write(`${receipt.passed} passed, ${receipt.failed} failed; receipt ${join(artifacts, "receipt.json")}\n`);
  rmSync(temporary, { recursive: true, force: true, maxRetries: 3 });
  process.exit(exitCode);
}
