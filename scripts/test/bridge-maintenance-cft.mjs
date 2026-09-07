#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "../..");
const EXTENSION = join(ROOT, "connector/extension");
const EXTENSION_ID = "abeloclekioohahgedmjcdbpllfjfhko";
const temporary = mkdtempSync(join(tmpdir(), "morrow-bridge-maintenance-cft-"));
const extensionLayer = join(temporary, "Morrow Bridge");
const profile = join(temporary, "profile");
const manifest = JSON.parse(readFileSync(join(EXTENSION, "manifest.json"), "utf8"));
const marker = `${JSON.stringify({
  schema: "morrow.bridge.active-folder-challenge.v1",
  extensionId: EXTENSION_ID,
  manifestVersion: manifest.version,
  challengeId: "morrow-bridge-cft-active-folder",
  nonce: "morrow-bridge-cft-nonce-20260906",
})}\n`;
const markerDigest = createHash("sha256").update(marker).digest("hex");

async function waitForServiceWorker(context) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const worker = context.serviceWorkers().find((candidate) => candidate.url() === `chrome-extension://${EXTENSION_ID}/src/service-worker.js`);
    if (worker) return worker;
    await delay(100);
  }
  throw new Error("bridge_service_worker_not_loaded");
}

cpSync(EXTENSION, extensionLayer, { recursive: true });
writeFileSync(join(extensionLayer, "morrow-bridge-active-folder.json"), marker, "utf8");

let context;
try {
  const executablePath = chromium.executablePath();
  assert.equal(executablePath.includes("Google Chrome for Testing"), true, "chrome_for_testing_executable_required");
  context = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath,
    args: [
      `--disable-extensions-except=${extensionLayer}`,
      `--load-extension=${extensionLayer}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  const worker = await waitForServiceWorker(context);
  const readback = await worker.evaluate(async () => {
    const self = await chrome.management.getSelf();
    const response = await fetch(chrome.runtime.getURL("morrow-bridge-active-folder.json"), { cache: "no-store" });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const marker = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return {
      runtimeId: chrome.runtime.id,
      manifestVersion: chrome.runtime.getManifest().version,
      self: { id: self.id, version: self.version, installType: self.installType, permissions: self.permissions },
      marker,
      markerSha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    };
  });

  assert.deepEqual(readback, {
    runtimeId: EXTENSION_ID,
    manifestVersion: manifest.version,
    self: {
      id: EXTENSION_ID,
      version: manifest.version,
      installType: "development",
      permissions: ["activeTab", "alarms", "offscreen", "scripting", "storage", "tabs", "webNavigation", "webRequest"],
    },
    marker: JSON.parse(marker),
    markerSha256: markerDigest,
  });
  assert.equal(JSON.stringify(readback).includes(temporary), false, "bridge_status_must_not_disclose_layer_path");
  process.stdout.write("bridge-maintenance-cft: loaded isolated Bridge worker and verified the exact active-folder proof without LMS navigation or writes\n");
} finally {
  await context?.close();
  rmSync(temporary, { recursive: true, force: true });
}
