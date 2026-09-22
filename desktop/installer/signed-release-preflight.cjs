"use strict";

/**
 * Checks, without building anything, whether a signed Morrow release could be
 * built here: MORROW_SIGNED_RELEASE=1 turns on forceCodeSigning and publishes
 * latest.yml or latest-mac.yml to the update feed (electron-builder.config.cjs).
 * It reports "not_configured" when no signing secret is present, "invalid" when
 * the secrets present do not form a complete signature, and "ready" otherwise.
 * It never prints a secret value.
 */

const fs = require("node:fs");
const path = require("node:path");
const { UPDATE_FEED, desktopUpdateMetadata, electronBuilderPublish } = require("./shared/update-feed.cjs");

const STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const TARGETS = Object.freeze({
  "darwin-arm64": {
    metadata: "latest-mac.yml",
    certificate: [["CSC_LINK", "CSC_NAME"]],
    password: ["CSC_KEY_PASSWORD"],
    notarization: [
      ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
      ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"],
    ],
  },
  "win32-x64": {
    metadata: "latest.yml",
    certificate: [["WIN_CSC_LINK", "CSC_LINK"]],
    password: ["WIN_CSC_KEY_PASSWORD", "CSC_KEY_PASSWORD"],
    notarization: null,
  },
});

function present(env, name) {
  return typeof env[name] === "string" && env[name].trim().length > 0;
}

function signedReleasePreflight({ target, version, env = process.env }) {
  const rules = TARGETS[target];
  if (!rules) throw new TypeError(`Unknown desktop target ${target}`);
  const missing = [];
  const certificate = rules.certificate[0].some((name) => present(env, name));
  const password = rules.password.some((name) => present(env, name)) || (target === "darwin-arm64" && present(env, "CSC_NAME"));
  const notarizationSets = rules.notarization || [];
  const notarization = notarizationSets.find((set) => set.every((name) => present(env, name)));
  const partialNotarization = notarizationSets.some((set) => set.some((name) => present(env, name)) && !set.every((name) => present(env, name)));
  const token = present(env, "GH_TOKEN");
  const anySigning = certificate || rules.password.some((name) => present(env, name))
    || notarizationSets.some((set) => set.some((name) => present(env, name)));

  if (!certificate) missing.push(rules.certificate[0].join(" or "));
  if (!password) missing.push(rules.password.join(" or "));
  if (rules.notarization && !notarization) missing.push(notarizationSets.map((set) => set.join(" + ")).join(" or "));
  if (!token) missing.push("GH_TOKEN");

  const feedProblems = [];
  const publish = electronBuilderPublish();
  const metadata = desktopUpdateMetadata(true);
  if (publish.provider !== UPDATE_FEED.provider || publish.owner !== UPDATE_FEED.owner || publish.repo !== UPDATE_FEED.repo
    || publish.channel !== "latest" || metadata.enabled !== true || metadata.feedId !== UPDATE_FEED.id) {
    feedProblems.push("The publish feed is not the update feed the app reads.");
  }
  const signingProblems = [];
  if (!STABLE_VERSION.test(String(version || ""))) signingProblems.push(`A signed release must use a stable version, and this one is ${version}.`);
  if (!certificate) signingProblems.push("A signing password or notarization value is set without a signing certificate.");
  if (certificate && !password) signingProblems.push("A signing certificate is set without its password.");
  if (rules.notarization && certificate && !notarization) {
    signingProblems.push(partialNotarization
      ? "Apple notarization credentials are incomplete."
      : "A macOS signing certificate is set without Apple notarization credentials.");
  }
  if (!token) signingProblems.push("A signed release publishes its update files, so GH_TOKEN is required.");

  const problems = anySigning ? [...feedProblems, ...signingProblems] : feedProblems;
  return {
    schema: "morrow.signed-release-preflight.v1",
    target,
    version,
    status: feedProblems.length > 0 ? "invalid" : !anySigning ? "not_configured" : signingProblems.length > 0 ? "invalid" : "ready",
    missing,
    problems,
    updateFeed: {
      provider: publish.provider,
      owner: publish.owner,
      repo: publish.repo,
      channel: publish.channel,
      metadata: rules.metadata,
    },
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] || null;
}

if (require.main === module) {
  const target = argument("--target");
  const version = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version;
  const result = signedReleasePreflight({ target, version, env: process.env });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  const line = result.status === "not_configured"
    ? `Signed release is not configured for ${target}: ${result.missing.join("; ")} not set. This build stays unsigned.`
    : result.status === "ready"
      ? `Signed release is configured for ${target}. It would sign and publish ${result.updateFeed.metadata}.`
      : `Signed release configuration for ${target} is invalid: ${result.problems.join(" ")}`;
  process.stderr.write(`${line}\n`);
  if (process.argv.includes("--summary") && process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Signed release preflight (${target})\n\n${line}\n`);
  }
  process.exitCode = result.status === "invalid" ? 1 : 0;
}

module.exports = { signedReleasePreflight };
