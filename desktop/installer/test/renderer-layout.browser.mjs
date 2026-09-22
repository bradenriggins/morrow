#!/usr/bin/env node
/**
 * Reads the installer window's real layout in Chromium: the Home view's
 * action panel and progress rail, where the Updates and Blackboard panels
 * sit against each other on the Settings view, from 1180px down to the 320px
 * window minimum, how large the step labels stay, which managed-device note
 * renders, and what the busy treatment draws. It needs Playwright's Chromium, so `pnpm --dir installer
 * test` leaves it out; run it with `pnpm --dir installer test:layout`.
 *
 * Chromium is not Electron. This proves the stylesheet and the renderer, not
 * the packaged Morrow window on macOS or Windows. It serves the installer over
 * a loopback address because Chromium refuses module scripts on file://, which
 * Electron's file:// protocol allows.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const { installerState } = require("../shared/contract.cjs");

const ROOT = path.resolve(import.meta.dirname, "..");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf"
};
const WIDTHS = [1180, 1000, 900, 760, 700, 440, 320];
const BASE = {
  lifecycle: "assistant_ready",
  assistants: [{ id: "codex", title: "ChatGPT", tier: "primary", supported: true, detected: true, configured: true, selected: true }],
  selectedAssistantId: "codex",
  workspaceSelected: true,
  runtimeStatus: "ready",
  bridgeDelivery: "developer_temporary",
  bridgeLoadedInChrome: true,
  bridgeFolderReady: true,
  bridgePaired: "unknown",
  courseSite: "unknown",
  runtimeVerifiedCourseCount: 0,
  selectedCourseName: null,
  updates: { status: "idle", automatic: true, currentVersion: "1.0.0" }
};
// Both panels are visible once an assistant is configured; the intro with its
// managed-device notes is visible before that.
const CONFIGURED = installerState(BASE);
const WELCOME = installerState({
  ...BASE,
  lifecycle: "ready_for_assistant",
  assistants: [{ id: "codex", title: "ChatGPT", tier: "primary", supported: true, detected: true }],
  selectedAssistantId: null
});
const DISCLOSURES = installerState({
  ...BASE,
  lifecycle: "ready_for_assistant",
  assistants: [
    { id: "codex", title: "ChatGPT", tier: "primary", supported: true, detected: true },
    { id: "claude-code", title: "Claude Code", tier: "advanced", supported: true, detected: true, needsWorkspace: true }
  ],
  selectedAssistantId: null,
  materialsFolder: null
});

function serveInstaller() {
  const server = createServer((request, response) => {
    const file = path.join(ROOT, path.normalize(new URL(request.url, "http://127.0.0.1").pathname));
    if (file !== ROOT && !file.startsWith(`${ROOT}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    readFile(file).then((bytes) => {
      response.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
      response.end(bytes);
    }, () => response.writeHead(404).end());
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function openSetup(browser, platform, state) {
  const page = await browser.newPage();
  page.on("pageerror", (error) => assert.fail(`the renderer failed: ${error.message}`));
  await page.addInitScript(([snapshot, reported]) => {
    window.__morrowTestClock = 100_000;
    window.__morrowInvocations = [];
    Date.now = () => window.__morrowTestClock;
    let updateListener = null;
    window.morrowInstaller = {
      platform: reported,
      invoke: async (...input) => {
        window.__morrowInvocations.push(input);
        return { schema: "morrow.installer-result.v1", ok: true, state: snapshot };
      },
      subscribeUpdates(listener) {
        updateListener = listener;
        window.__morrowPublishUpdate = (value) => updateListener?.(value);
        return () => { if (updateListener === listener) updateListener = null; };
      }
    };
  }, [state, platform]);
  await page.goto(INDEX);
  await page.waitForSelector("#action-content:not([hidden])");
  return page;
}

function measure(page) {
  return page.evaluate(() => {
    const box = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    };
    return {
      action: box(".action-panel"),
      updates: box("#updates-panel"),
      blackboard: box("#blackboard-panel"),
      labels: [...document.querySelectorAll(".step-label")].map((label) => Number.parseFloat(getComputedStyle(label).fontSize)),
      steps: [...document.querySelectorAll(".progress-step")].map((step) => ({
        current: step.getAttribute("aria-current") === "step",
        detail: getComputedStyle(step.querySelector(".step-detail")).display !== "none"
      })),
      fits: document.documentElement.scrollWidth <= window.innerWidth
    };
  });
}

function aligned(panel, action, width, name) {
  for (const edge of ["left", "right", "width"]) {
    const drift = Math.abs(panel[edge] - action[edge]);
    assert.ok(drift <= 0.5, `${name} ${edge} is ${drift.toFixed(2)}px from the action panel at ${width}px`);
  }
}

// The active view uses `display: contents` so its own children keep their
// place in `.setup`'s grid (see renderer.js); the inactive one is
// `display: none`. A `display: contents` element has no box of its own, so
// Playwright's isHidden()/isVisible() are not reliable here: read the
// computed style directly instead.
function viewDisplay(page, selector) {
  return page.locator(selector).evaluate((element) => getComputedStyle(element).display);
}

const server = await serveInstaller();
const INDEX = `http://127.0.0.1:${server.address().port}/renderer/index.html`;
const browser = await chromium.launch();
try {
  // Home carries the wizard's progress rail and action panel. Updates, the
  // Blackboard connection and the setup a person can change moved to
  // Settings, a second view reached through the app nav (D8, D9), so the two
  // are never on screen together.
  const page = await openSetup(browser, "darwin", CONFIGURED);
  assert.equal(await viewDisplay(page, "#settings-view"), "none", "Settings starts hidden; Home is the default view");
  assert.equal(await viewDisplay(page, "#home-view"), "contents", "Home keeps its children in the grid");

  const markLoaded = await page.locator(".brand-mark").evaluate((image) => image.complete && image.naturalWidth > 0);
  assert.equal(markLoaded, true, "the knot mark must load in the renderer");

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    const measured = await measure(page);
    assert.equal(measured.steps.length, 3, `three stages must render at ${width}px`);
    for (const size of measured.labels) assert.ok(size >= 12, `a step label is ${size}px at ${width}px`);
    // Narrow widths keep the detail of the step the person is on; wider widths keep every detail.
    for (const step of measured.steps) assert.equal(step.detail, width > 720 || step.current, `step detail at ${width}px`);
    assert.equal(measured.steps.filter((step) => step.current).length, 1, `one current step at ${width}px`);
    assert.equal(measured.fits, true, `Home must not scroll sideways at ${width}px`);
    console.log(`${String(width).padStart(4)}px  home    action ${measured.action.left.toFixed(1)}–${measured.action.right.toFixed(1)}  label ${Math.min(...measured.labels)}px`);
  }

  await page.click("#nav-settings");
  await page.waitForSelector("#updates-panel:not([hidden])");
  await page.waitForSelector("#blackboard-panel:not([hidden])");
  assert.equal(await viewDisplay(page, "#home-view"), "none", "Home is hidden while Settings is the active view");
  assert.equal(await viewDisplay(page, "#settings-view"), "contents", "Settings keeps its children in the grid");

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    const measured = await measure(page);
    aligned(measured.updates, measured.blackboard, width, "the Updates panel against the Blackboard panel");
    assert.equal(measured.fits, true, `Settings must not scroll sideways at ${width}px`);
    console.log(`${String(width).padStart(4)}px  settings updates ${measured.updates.left.toFixed(1)}–${measured.updates.right.toFixed(1)}  blackboard ${measured.blackboard.left.toFixed(1)}–${measured.blackboard.right.toFixed(1)}`);
  }

  // #updates-actions lives on Settings, still the active view here.
  const updateAction = page.locator("#updates-actions [data-action]");
  await updateAction.focus();
  await page.evaluate(() => window.__morrowPublishUpdate({
    schema: "morrow.desktop-update.v1",
    revision: 1,
    status: "checking",
    currentVersion: "1.0.0",
    availableVersion: null,
    automatic: true,
    reason: null
  }));
  await page.waitForFunction(() => document.activeElement === document.querySelector("#updates-title"));
  assert.equal(await page.locator("#updates-actions [data-action]").count(), 0);
  console.log("focus   removed update action moves to the Updates heading");

  await page.click("#nav-home");
  await page.waitForSelector("#action-content:not([hidden])");

  const busy = await page.evaluate(() => {
    const setup = document.querySelector("#setup");
    const before = setup.getAttribute("aria-busy");
    setup.setAttribute("aria-busy", "true");
    const bar = getComputedStyle(document.querySelector(".action-panel"), "::after");
    const drawn = { content: bar.content, height: bar.height, animation: bar.animationName, cursor: getComputedStyle(setup).cursor };
    setup.setAttribute("aria-busy", before ?? "false");
    return drawn;
  });
  assert.equal(busy.content, '""', "the busy bar must render");
  assert.equal(busy.height, "3px");
  assert.equal(busy.animation, "working");
  assert.equal(busy.cursor, "progress");
  console.log(`busy    bar ${busy.height} ${busy.animation}, cursor ${busy.cursor}`);

  const disclosures = await openSetup(browser, "darwin", DISCLOSURES);
  for (const selector of [".advanced-assistants > summary", ".optional-setup > summary"]) {
    const summary = disclosures.locator(selector);
    await summary.focus();
    await disclosures.evaluate(() => {
      window.__morrowTestClock += 5_000;
      window.dispatchEvent(new Event("focus"));
    });
    await disclosures.waitForFunction((expected) => document.activeElement === document.querySelector(expected), selector);
  }
  console.log("focus   passive refresh restores both disclosure summaries");

  for (const [platform, shown, hidden] of [["darwin", "#macos-note", "#windows-note"], ["win32", "#windows-note", "#macos-note"]]) {
    const welcome = await openSetup(browser, platform, WELCOME);
    assert.equal(await welcome.locator(shown).isVisible(), true, `${shown} must render on ${platform}`);
    assert.equal(await welcome.locator(hidden).isVisible(), false, `${hidden} must not render on ${platform}`);
  }

  const actions = await openSetup(browser, "darwin", WELCOME);
  await actions.getByRole("button", { name: /ChatGPT/ }).click();
  await actions.getByRole("button", { name: "Set up ChatGPT" }).click();
  await actions.waitForFunction(() => window.__morrowInvocations.some(([method]) => method === "installer:install-assistant"));
  assert.deepEqual(
    await actions.evaluate(() => window.__morrowInvocations.find(([method]) => method === "installer:install-assistant")),
    ["installer:install-assistant", { assistantId: "codex" }]
  );
  console.log("actions delegated setup controls invoke their installer action");

  // The default Morrow window is 940px wide and can be dragged down to 320px.
  for (const width of [940, 320]) {
    const welcome = await openSetup(browser, "darwin", WELCOME);
    await welcome.setViewportSize({ width, height: 720 });
    const heading = await welcome.evaluate(() => {
      const title = document.querySelector("#setup-title");
      const intro = document.querySelector(".intro");
      const copy = document.querySelector(".intro-copy");
      const lineCount = (element) => Math.round(element.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(element).lineHeight));
      return {
        text: title.textContent,
        fits: title.scrollWidth <= title.clientWidth,
        lines: lineCount(title),
        introWidth: intro.getBoundingClientRect().width,
        copyWidth: copy.getBoundingClientRect().width,
        copyLines: lineCount(copy),
        copyWrap: getComputedStyle(copy).overflowWrap,
        sideways: document.documentElement.scrollWidth <= window.innerWidth
      };
    });
    assert.equal(heading.fits, true, `the setup heading must fit its box at ${width}px`);
    // Ordinary prose is capped to one readable measure (`--measure`, 68ch), so
    // it uses the available width only up to that cap and never past it: the
    // two match only while the box itself is narrower than the cap.
    assert.ok(heading.copyWidth <= heading.introWidth + 0.5, `the intro copy must not overflow its box at ${width}px`);
    assert.equal(heading.copyWrap, "break-word", `ordinary intro prose must wrap at word boundaries at ${width}px`);
    assert.ok(heading.copyLines >= 1, `the intro copy must render at least one line at ${width}px`);
    assert.equal(heading.sideways, true, `the welcome screen must not scroll sideways at ${width}px`);
    console.log(`${String(width).padStart(4)}px  heading "${heading.text}" on ${heading.lines} line(s), intro on ${heading.copyLines} line(s)`);
  }

  const unknown = await openSetup(browser, undefined, WELCOME);
  assert.equal(await unknown.locator("#windows-note").isVisible(), false);
  assert.equal(await unknown.locator("#macos-note").isVisible(), false);
  console.log("notes   macOS on darwin, Windows on win32, neither when the platform is unknown");
} finally {
  await browser.close();
  server.close();
}
