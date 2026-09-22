"use strict";

/*
 * Ways the signed-release preflight can fail, written before the change:
 * - With no signing secrets it passes silently, so "signed release" looks ready when nothing is set.
 * - A half-configured signature (certificate without password, Apple ID without team) passes.
 * - A prerelease version is accepted for a signed release, which electron-builder config refuses later.
 * - The update feed that writes latest.yml / latest-mac.yml is not the one the app reads.
 * - The macOS preflight accepts a certificate without notarization credentials.
 */

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { signedReleasePreflight } = require("../signed-release-preflight.cjs");

const MAC_READY = Object.freeze({
  CSC_LINK: "base64-certificate",
  CSC_KEY_PASSWORD: "password",
  APPLE_API_KEY: "key",
  APPLE_API_KEY_ID: "id",
  APPLE_API_ISSUER: "issuer",
  GH_TOKEN: "token",
});
const WIN_READY = Object.freeze({ WIN_CSC_LINK: "base64-certificate", WIN_CSC_KEY_PASSWORD: "password", GH_TOKEN: "token" });

test("no signing secrets reports not configured and names what is missing", () => {
  for (const target of ["darwin-arm64", "win32-x64"]) {
    const result = signedReleasePreflight({ target, version: "1.0.4", env: {} });
    assert.equal(result.status, "not_configured", target);
    assert.ok(result.missing.length > 0);
    assert.deepEqual(result.problems, []);
  }
});

test("a complete configuration is ready, and publishes to the feed the app reads", () => {
  const mac = signedReleasePreflight({ target: "darwin-arm64", version: "1.0.4", env: MAC_READY });
  assert.equal(mac.status, "ready");
  assert.deepEqual(mac.updateFeed, { provider: "github", owner: "bradenriggins", repo: "morrow-downloads", channel: "latest", metadata: "latest-mac.yml" });
  const windows = signedReleasePreflight({ target: "win32-x64", version: "1.0.4", env: WIN_READY });
  assert.equal(windows.status, "ready");
  assert.equal(windows.updateFeed.metadata, "latest.yml");
  const appleId = { ...MAC_READY, APPLE_API_KEY: "", APPLE_API_KEY_ID: "", APPLE_API_ISSUER: "", APPLE_ID: "a@b.c", APPLE_APP_SPECIFIC_PASSWORD: "p", APPLE_TEAM_ID: "T" };
  assert.equal(signedReleasePreflight({ target: "darwin-arm64", version: "1.0.4", env: appleId }).status, "ready");
});

test("a half-configured signature or a prerelease version is invalid, with the reason", () => {
  const noPassword = signedReleasePreflight({ target: "win32-x64", version: "1.0.4", env: { WIN_CSC_LINK: "c", GH_TOKEN: "t" } });
  assert.equal(noPassword.status, "invalid");
  assert.ok(noPassword.problems.some((problem) => /password/i.test(problem)));
  const noNotarization = signedReleasePreflight({ target: "darwin-arm64", version: "1.0.4", env: { CSC_LINK: "c", CSC_KEY_PASSWORD: "p", GH_TOKEN: "t" } });
  assert.equal(noNotarization.status, "invalid");
  assert.ok(noNotarization.problems.some((problem) => /notariz/i.test(problem)));
  const prerelease = signedReleasePreflight({ target: "win32-x64", version: "1.0.4-rc.1", env: WIN_READY });
  assert.equal(prerelease.status, "invalid");
  assert.ok(prerelease.problems.some((problem) => /stable/i.test(problem)));
  assert.equal(JSON.stringify(signedReleasePreflight({ target: "win32-x64", version: "1.0.4", env: WIN_READY })).includes("base64-certificate"), false,
    "the report never carries a secret value");
});

test("the command exits 0 for not configured and ready, 1 for invalid, and prints its report", () => {
  const script = path.join(__dirname, "..", "signed-release-preflight.cjs");
  const run = (env) => spawnSync(process.execPath, [script, "--target", "win32-x64"], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  const unset = run({});
  assert.equal(unset.status, 0);
  assert.equal(JSON.parse(unset.stdout).status, "not_configured");
  assert.match(unset.stderr, /Signed release is not configured/);
  assert.equal(run(WIN_READY).status, 0);
  assert.equal(run({ WIN_CSC_LINK: "c", GH_TOKEN: "t" }).status, 1);
});
