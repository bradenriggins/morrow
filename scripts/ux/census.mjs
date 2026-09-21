#!/usr/bin/env node
/**
 * WI-T.1: a census of computed styles across every Morrow surface, so a later
 * work item has a baseline (WI-0.1) and a check against the WI-F.2 targets.
 *
 * Reuses the Chromium start-up of scripts/test/canvas-connector-browser.mjs
 * (Chrome for Testing, `--load-extension`, the Bridge loaded) to open the
 * popup, the settings page and the setup guide; serves the desktop renderer
 * on a loopback address with the installer/test/renderer-layout.browser.mjs
 * stub; and renders the review page with a stub controller the way
 * scripts/test/bridge-copy-guard.test.mjs does, through LoopbackApprovalServer.
 *
 * It reads computed styles only. It changes nothing. It is not in the gate,
 * because it needs Chromium. Run it with `--check` to exit 1 when a surface
 * misses a WI-F.2 target.
 */

import { createRequire } from "node:module";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, extname, normalize, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { launchManagedChromiumPersistentContext } from "../lib/playwright-managed-browser.mjs";
import { LoopbackApprovalServer } from "../../packages/mcp-server/dist/approval-server.js";
import { CENSUS_EXPRESSION } from "../../docs/implementation/ux/reference/census-expression.js";

const require = createRequire(import.meta.url);
const { installerState } = require("../../installer/shared/contract.cjs");

const CHECK = process.argv.includes("--check");

const ROOT = resolve(import.meta.dirname, "../..");
const EXTENSION = resolve(ROOT, "connector/extension");
const EXTENSION_ID = "abeloclekioohahgedmjcdbpllfjfhko";

/** WI-F.2's acceptance targets. */
const TARGETS = { sizes: 7, weights: 3, lineHeights: 4, radii: 4 };
/** WI-F.1's space tokens, in px. Gap and padding values must come from this set. */
const SPACE_TOKENS_PX = new Set([4, 8, 12, 16, 24, 32, 48]);

function tokenCompliant(value) {
  return value.split(/\s+/).every((part) => {
    const match = /^(-?\d+(?:\.\d+)?)px$/.exec(part);
    if (!match) return false;
    const n = Number(match[1]);
    return n === 0 || SPACE_TOKENS_PX.has(n);
  });
}

function offTokenValues(entries) {
  // entries look like "8px ×5"; keep the ones whose value is not a space token.
  return entries.filter((entry) => !tokenCompliant(entry.split(" ×")[0])).map((entry) => entry.split(" ×")[0]);
}

const INSTALLER_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
};

/** The renderer's "set up" state: an assistant is configured, both side panels visible. */
const INSTALLER_STATE = installerState({
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
  updates: { status: "idle", automatic: true, currentVersion: "1.0.0" },
});

function serveInstaller(installerRoot) {
  const server = createServer((request, response) => {
    const file = join(installerRoot, normalize(new URL(request.url, "http://127.0.0.1").pathname));
    if (file !== installerRoot && !file.startsWith(`${installerRoot}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    readFile(file).then((bytes) => {
      response.writeHead(200, { "content-type": INSTALLER_TYPES[extname(file)] || "application/octet-stream" });
      response.end(bytes);
    }, () => response.writeHead(404).end());
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** The same stub controller scripts/test/bridge-copy-guard.test.mjs uses, one operation. */
function approvalController(snapshot) {
  return {
    operationGet: () => snapshot,
    operationList: () => ({ schema: "morrow.operations.list.v1", returned: 1, operations: [snapshot] }),
    approveOperation: () => snapshot,
    runApprovedOperation: async () => undefined,
    cancelOperation: () => snapshot,
    setApprovalBaseUrl: () => undefined,
  };
}

const REVIEW_SNAPSHOT = {
  operationId: "op:census-review",
  state: "awaiting_approval",
  approvalExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  plan: {
    tool: "canvas_create_quiz_item",
    arguments: {
      item_entry_title: "Red blood cell function",
      item_entry_interaction_type_slug: "choice",
      item_entry_item_body: "<p>What do red blood cells carry?</p>",
      item_points_possible: 1,
    },
  },
};

/**
 * The popup and the setup guide gate their main content behind the course-data
 * disclosure, but the guide skips its own gate once the popup already recorded
 * consent, so `#consent-action` never becomes visible there. Wait for either the
 * button or the gated content, click the button only if it is the one that showed.
 */
async function passDisclosure(page, contentSelector) {
  const consentAction = page.locator("#consent-action:not([hidden])");
  const content = page.locator(contentSelector);
  await Promise.race([
    consentAction.waitFor({ timeout: 10_000 }).catch(() => undefined),
    content.waitFor({ timeout: 10_000 }).catch(() => undefined),
  ]);
  if (await consentAction.isVisible().catch(() => false)) await consentAction.click();
  await content.waitFor();
}

async function census(page) {
  const raw = await page.evaluate(CENSUS_EXPRESSION);
  return JSON.parse(raw);
}

async function main() {
  const temporary = mkdtempSync(join(tmpdir(), "morrow-ux-census-"));
  const extensionCopy = join(temporary, "extension");
  cpSync(EXTENSION, extensionCopy, { recursive: true });

  const approvalServer = new LoopbackApprovalServer(approvalController(REVIEW_SNAPSHOT));
  const approvalBaseUrl = await approvalServer.start();
  const installerHttp = await serveInstaller(resolve(ROOT, "installer"));

  const profile = join(temporary, "chrome-profile");
  const context = await launchManagedChromiumPersistentContext(chromium, profile, {
    headless: false,
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${extensionCopy}`,
      `--load-extension=${extensionCopy}`,
      "--allow-insecure-localhost",
      "--ignore-certificate-errors",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  const results = [];
  try {
    // Both the popup and the setup guide gate their main content behind the course-data
    // disclosure. Agree, so the census measures the connected view (the WI-F.2 baseline
    // table's counts), not just the five-element consent screen.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${EXTENSION_ID}/popup/popup.html`);
    await passDisclosure(popup, "#connection-content:not([hidden])");
    await popup.locator("#primary").waitFor();
    results.push(["Popup", await census(popup)]);

    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${EXTENSION_ID}/settings/settings.html`);
    await settings.getByRole("heading", { name: "Plan and Edit settings" }).waitFor();
    results.push(["Settings page", await census(settings)]);

    const onboarding = context.pages().find((candidate) => candidate.url() === `chrome-extension://${EXTENSION_ID}/onboarding/onboarding.html`)
      || await context.newPage();
    if (onboarding.url() !== `chrome-extension://${EXTENSION_ID}/onboarding/onboarding.html`) {
      await onboarding.goto(`chrome-extension://${EXTENSION_ID}/onboarding/onboarding.html`);
    }
    await passDisclosure(onboarding, "#setup-content:not([hidden])");
    results.push(["Setup guide", await census(onboarding)]);

    const review = await context.newPage();
    await review.goto(`${approvalBaseUrl}/operations/${encodeURIComponent(REVIEW_SNAPSHOT.operationId)}`);
    await review.locator(".hero h1").waitFor();
    results.push(["Edit list", await census(review)]);

    const desktop = await context.newPage();
    await desktop.addInitScript(([state]) => {
      window.morrowInstaller = {
        platform: "darwin",
        invoke: async () => ({ schema: "morrow.installer-result.v1", ok: true, state }),
        subscribeUpdates: () => () => undefined,
      };
    }, [INSTALLER_STATE]);
    await desktop.goto(`http://127.0.0.1:${installerHttp.address().port}/renderer/index.html`);
    await desktop.locator("#action-content:not([hidden])").waitFor();
    results.push(["Desktop app, set up", await census(desktop)]);
  } finally {
    await context.close();
    await approvalServer.close();
    installerHttp.close();
    rmSync(temporary, { recursive: true, force: true });
  }

  const header = ["Surface", "Sizes", "Weights", "LineHt", "Radii", "Gaps", "Paddings", "Small text", "Small targets", "Long lines"];
  const rows = results.map(([name, data]) => [
    name,
    String(data.distinctSizes),
    String(data.weights.length),
    String(data.distinctLH),
    String(data.distinctRadii),
    String(data.distinctGaps),
    String(data.distinctPaddings),
    `${data.smallText} of ${data.textEls}`,
    String(data.smallTargetCount),
    String(data.longLines),
  ]);
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index].length)));
  const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ");
  console.log(line(header));
  for (const row of rows) console.log(line(row));

  if (!CHECK) return;

  let failed = false;
  for (const [name, data] of results) {
    const problems = [];
    if (data.distinctSizes > TARGETS.sizes) problems.push(`${data.distinctSizes} font sizes (target ${TARGETS.sizes} or fewer)`);
    if (data.weights.length > TARGETS.weights) problems.push(`${data.weights.length} weights (target ${TARGETS.weights})`);
    if (data.distinctLH > TARGETS.lineHeights) problems.push(`${data.distinctLH} line heights (target ${TARGETS.lineHeights} or fewer)`);
    if (data.distinctRadii > TARGETS.radii) problems.push(`${data.distinctRadii} radii (target ${TARGETS.radii} or fewer)`);
    if (data.smallText > 0) problems.push(`${data.smallText} text elements under 13px (target 0)`);
    const offGaps = offTokenValues(data.gaps);
    if (offGaps.length) problems.push(`gap values off the space tokens: ${offGaps.join(", ")}`);
    const offPaddings = offTokenValues(data.paddings);
    if (offPaddings.length) problems.push(`padding values off the space tokens: ${offPaddings.join(", ")}`);
    if (problems.length) {
      failed = true;
      console.log(`${name}: ${problems.join("; ")}`);
    }
  }
  if (failed) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
