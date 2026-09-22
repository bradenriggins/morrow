#!/usr/bin/env node

/**
 * Reports whether this host and this repository hold the inputs a signed, notarized public Morrow
 * release needs. It is read-only and offline: it reads the local code-signing identity list, whether
 * named environment variables are set, and the release workflow file. It signs nothing, it notarizes
 * nothing, and it contacts no service.
 *
 * The receipt carries booleans, counts, and input names only. It never carries an identity string, a
 * certificate, an Apple ID, a team id, or the value of any variable.
 *
 * `publicReleaseBlocked` is true while any input is missing or could not be inspected on this host.
 * A false value means every input this check can see is present. It is not proof that a signature or
 * a notarization succeeded. A blocked receipt is a normal result: the command still exits 0, so a
 * caller reads the missing list instead of a failed build.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_WORKFLOW = ".github/workflows/desktop-release.yml";
const IDENTITY_QUERY = "security find-identity -v -p codesigning";
const INSPECTION_REASONS = Object.freeze(["host_is_not_macos", "security_tool_unavailable"]);

/** The sentence scripts/package-mcp-bundle.mjs throws when it refuses to package a public release. */
export const PUBLIC_RELEASE_BLOCKED_MESSAGE = "This host has no configured release-signing proof. Pass --unsigned-qa only for a private QA artifact; public release packaging is blocked.";
export const SIGNING_INPUTS_PRESENT_MESSAGE = "Every release-signing input this check can inspect is present. This check signs nothing and contacts no service, so it does not prove that a signature or a notarization succeeded.";

export const MACOS_IDENTITY_INPUT = "macos_developer_id_application_identity";
export const MACOS_SIGNING_STRATEGY_INPUT = "macos_signing_strategy";
export const MACOS_NOTARIZATION_STRATEGY_INPUT = "macos_notarization_strategy";
export const MACOS_SIGNING_NOTARIZATION_WORKFLOW_INPUT = "macos_signing_notarization_workflow_target";
export const WINDOWS_SIGNING_STRATEGY_INPUT = "windows_signing_strategy";
export const MACOS_SIGNING_VARIABLES = Object.freeze([
  "CSC_LINK", "CSC_KEY_PASSWORD", "CSC_NAME",
  "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID",
  "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER",
  "APPLE_KEYCHAIN_PROFILE", "APPLE_KEYCHAIN",
]);
export const WINDOWS_SIGNING_VARIABLES = Object.freeze(["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"]);
/** Repository secret names that would carry signing material into a workflow run. */
export const SIGNING_SECRET_NAMES = Object.freeze([
  "APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_ID", "APPLE_KEYCHAIN", "APPLE_KEYCHAIN_PROFILE", "APPLE_TEAM_ID",
  "CSC_INSTALLER_KEY_PASSWORD", "CSC_INSTALLER_LINK", "CSC_KEY_PASSWORD", "CSC_LINK", "CSC_NAME",
  "WIN_CSC_KEY_PASSWORD", "WIN_CSC_LINK"
]);
/** A repository can name a signing secret anything, so a shaped name counts as well as a known one. */
const SIGNING_SECRET_SHAPE = /CERT|CODESIGN|NOTAR|P12|PFX|SIGNING/i;
const MACOS_SIGNATURE_STRATEGIES = Object.freeze([
  Object.freeze({ id: "certificate", environment: ["CSC_LINK", "CSC_KEY_PASSWORD"], workflowSecrets: ["CSC_LINK", "CSC_KEY_PASSWORD"] }),
  Object.freeze({ id: "keychain_identity", identity: true, environment: ["CSC_NAME"], workflowSecrets: ["CSC_NAME"] }),
]);
const MACOS_NOTARIZATION_STRATEGIES = Object.freeze([
  Object.freeze({ id: "apple_id", environment: ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"], workflowSecrets: ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"] }),
  Object.freeze({ id: "api_key", environment: ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"], workflowSecrets: ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"] }),
  Object.freeze({ id: "keychain_profile", environment: ["APPLE_KEYCHAIN_PROFILE"], optionalEnvironment: ["APPLE_KEYCHAIN"], workflowSecrets: ["APPLE_KEYCHAIN_PROFILE"] }),
]);
const WINDOWS_SIGNATURE_STRATEGIES = Object.freeze([
  Object.freeze({ id: "certificate", environment: ["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"], workflowSecrets: ["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"] }),
]);

const WORKFLOW_TARGET_COMMANDS = Object.freeze({
  macos: /(?:^|\s)(?:package:mac|electron-builder\b[^\r\n]*\s--mac(?:\s|$))/,
  windows: /(?:^|\s)(?:package:win|electron-builder\b[^\r\n]*\s--win(?:\s|$))/,
});

/** Counts `Developer ID Application` rows in a `security find-identity` listing without reading the identity string. */
export function developerIdApplicationCount(listing) {
  return String(listing)
    .split("\n")
    .filter((line) => /^\s*\d+\)\s+[0-9A-Fa-f]{8,}\s+"Developer ID Application:/.test(line))
    .length;
}

/** Every repository secret a workflow reads, by name. A shell line that clears a variable reads no secret. */
export function referencedSecretNames(workflow) {
  const names = new Set();
  for (const match of String(workflow).matchAll(/\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) names.add(match[1]);
  return [...names].sort();
}

export function isSigningSecretName(name) {
  return SIGNING_SECRET_NAMES.includes(name) || SIGNING_SECRET_SHAPE.test(name);
}

function workflowSecretBindings(value) {
  const bindings = new Map();
  for (const line of String(value).split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*):\s*\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$/.exec(line);
    if (match) bindings.set(match[1], match[2]);
  }
  return bindings;
}

function signedReleaseEnabled(value) {
  return /^\s*MORROW_SIGNED_RELEASE:\s*["']?1["']?\s*$/m.test(value)
    || /(?:^|[;&|]\s*|\s)(?:export\s+)?MORROW_SIGNED_RELEASE=1(?:\s|$)/m.test(value)
    || /\$env:MORROW_SIGNED_RELEASE\s*=\s*["']1["']/i.test(value);
}

function workflowJobs(workflow) {
  if (workflow === null) return [];
  const lines = String(workflow).split(/\r?\n/);
  const jobsLine = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsLine < 0) return [{ text: String(workflow) }];
  const jobs = [];
  for (let index = jobsLine + 1; index < lines.length;) {
    if (/^\S/.test(lines[index])) break;
    const match = /^  ([A-Za-z0-9_-]+):\s*$/.exec(lines[index]);
    if (!match) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < lines.length && !/^\S/.test(lines[end]) && !/^  [A-Za-z0-9_-]+:\s*$/.test(lines[end])) end += 1;
    jobs.push({ id: match[1], text: lines.slice(index, end).join("\n") });
    index = end;
  }
  return jobs;
}

function workflowTargetSteps(workflow, target) {
  const candidates = [];
  for (const job of workflowJobs(workflow)) {
    const lines = job.text.split(/\r?\n/);
    const stepStarts = lines
      .map((line, index) => (/^ {6}-\s/.test(line) ? index : -1))
      .filter((index) => index >= 0);
    const jobPrefix = stepStarts.length > 0 ? lines.slice(0, stepStarts[0]).join("\n") : "";
    const jobBindings = workflowSecretBindings(jobPrefix);
    const stepBlocks = stepStarts.length > 0
      ? stepStarts.map((start, index) => lines.slice(start, stepStarts[index + 1] ?? lines.length).join("\n"))
      : [job.text];
    for (const step of stepBlocks) {
      if (!WORKFLOW_TARGET_COMMANDS[target].test(step)) continue;
      const bindings = new Map([...jobBindings, ...workflowSecretBindings(step)]);
      candidates.push({
        job: job.id ?? null,
        signedRelease: signedReleaseEnabled(`${jobPrefix}\n${step}`),
        secretBindings: Object.fromEntries([...bindings].sort(([left], [right]) => left.localeCompare(right))),
      });
    }
  }
  return candidates;
}

/** A variable set to an empty string is not a usable credential, so presence requires a value. */
function presence(environment, names) {
  return Object.fromEntries(names.map((name) => [name, typeof environment[name] === "string" && environment[name].trim() !== ""]));
}

/** Rebuilt field by field so nothing a caller passed in can reach the receipt unchecked. */
function identityState(identities) {
  if (!identities?.inspected) {
    const reason = String(identities?.reason ?? "");
    if (!INSPECTION_REASONS.includes(reason)) throw new Error(`An uninspected identity list must carry one of these reasons: ${INSPECTION_REASONS.join(", ")}.`);
    return { inspected: false, query: IDENTITY_QUERY, reason };
  }
  if (!Number.isInteger(identities.developerIdApplication) || identities.developerIdApplication < 0) {
    throw new Error("An inspected identity list must carry a whole Developer ID Application count.");
  }
  return { inspected: true, query: IDENTITY_QUERY, developerIdApplication: identities.developerIdApplication };
}

function strategyState(strategy, { identity, environment, workflowTargets }) {
  const optionalEnvironment = (strategy.optionalEnvironment || []).filter((name) => environment[name] === true);
  const requiredEnvironment = [...strategy.environment, ...optionalEnvironment];
  const requiredWorkflowSecrets = [...strategy.workflowSecrets, ...optionalEnvironment];
  const missingEnvironment = requiredEnvironment.filter((name) => environment[name] !== true);
  const wiredTarget = workflowTargets.find((target) => target.signedRelease
    && requiredWorkflowSecrets.every((name) => typeof target.secretBindings[name] === "string"));
  const missingWorkflowSecrets = wiredTarget
    ? []
    : requiredWorkflowSecrets.filter((name) => !workflowTargets.some((target) => typeof target.secretBindings[name] === "string"));
  const identityReady = strategy.identity !== true
    || (identity.inspected === true && identity.developerIdApplication > 0);
  return {
    id: strategy.id,
    available: identityReady && missingEnvironment.length === 0 && wiredTarget !== undefined,
    identityRequired: strategy.identity === true,
    identityReady,
    requiredEnvironment,
    missingEnvironment,
    requiredWorkflowSecrets,
    missingWorkflowSecrets,
    signedWorkflowTargetReady: wiredTarget !== undefined,
    workflowSecrets: wiredTarget
      ? requiredWorkflowSecrets.map((name) => wiredTarget.secretBindings[name]).sort()
      : [],
  };
}

function strategyGroup(strategies, context) {
  const options = strategies.map((strategy) => strategyState(strategy, context));
  return { selected: options.find((option) => option.available)?.id ?? null, options };
}

function selectedMacosStrategies(signing, notarization, workflowTargets) {
  for (const signingOption of signing.options) {
    if (!signingOption.identityReady || signingOption.missingEnvironment.length > 0) continue;
    for (const notarizationOption of notarization.options) {
      if (!notarizationOption.identityReady || notarizationOption.missingEnvironment.length > 0) continue;
      const required = new Set([...signingOption.requiredWorkflowSecrets, ...notarizationOption.requiredWorkflowSecrets]);
      if (workflowTargets.some((target) => target.signedRelease
        && [...required].every((name) => typeof target.secretBindings[name] === "string"))) {
        return { signing: signingOption.id, notarization: notarizationOption.id };
      }
    }
  }
  return null;
}

/**
 * The receipt. `workflow` is the release workflow text, or null when the repository has no such file.
 * `missing` holds the inputs this host proved absent; `notInspected` holds the ones it could not read
 * here, so an unknown input never reads as a definite answer.
 */
export function buildReleaseSigningPreflight({ platform, identities, environment = {}, workflow = null }) {
  const identity = identityState(identities);
  const macosEnvironment = presence(environment, MACOS_SIGNING_VARIABLES);
  const windowsEnvironment = presence(environment, WINDOWS_SIGNING_VARIABLES);
  const referencedSecrets = workflow === null ? [] : referencedSecretNames(workflow);
  const signingSecrets = referencedSecrets.filter(isSigningSecretName);
  const baseContext = {
    identity,
    environment: { ...macosEnvironment, ...windowsEnvironment },
  };
  const macosTargets = workflowTargetSteps(workflow, "macos");
  const windowsTargets = workflowTargetSteps(workflow, "windows");
  const macosContext = { ...baseContext, workflowTargets: macosTargets };
  const windowsContext = { ...baseContext, workflowTargets: windowsTargets };
  const macosSigningOptions = strategyGroup(MACOS_SIGNATURE_STRATEGIES, macosContext);
  const macosNotarizationOptions = strategyGroup(MACOS_NOTARIZATION_STRATEGIES, macosContext);
  const selectedMacos = selectedMacosStrategies(macosSigningOptions, macosNotarizationOptions, macosTargets);
  const macosSigning = macosSigningOptions;
  const macosNotarization = macosNotarizationOptions;
  const windowsSigning = strategyGroup(WINDOWS_SIGNATURE_STRATEGIES, windowsContext);

  const missing = [];
  const notInspected = [];
  if (macosSigning.selected === null) missing.push(MACOS_SIGNING_STRATEGY_INPUT);
  if (macosNotarization.selected === null) missing.push(MACOS_NOTARIZATION_STRATEGY_INPUT);
  if (macosSigning.selected !== null && macosNotarization.selected !== null && selectedMacos === null) {
    missing.push(MACOS_SIGNING_NOTARIZATION_WORKFLOW_INPUT);
  }
  if (windowsSigning.selected === null) missing.push(WINDOWS_SIGNING_STRATEGY_INPUT);
  if (!identity.inspected && macosSigning.selected === null) notInspected.push(MACOS_IDENTITY_INPUT);
  const blocked = missing.length > 0 || notInspected.length > 0;

  return {
    schema: "morrow.release-signing-preflight.v2",
    host: { platform: String(platform) },
    macos: {
      identities: identity,
      environment: macosEnvironment,
      signing: macosSigning,
      notarization: macosNotarization,
      signedWorkflowTargetReady: selectedMacos !== null,
    },
    windows: { environment: windowsEnvironment, signing: windowsSigning },
    repository: {
      workflow: RELEASE_WORKFLOW,
      present: workflow !== null,
      referencedSecrets,
      referencesSigningSecret: signingSecrets.length > 0,
      signedTargets: { macos: macosTargets, windows: windowsTargets },
    },
    mode: blocked ? "unsigned_private_qa" : "signing_inputs_present",
    publicReleaseBlocked: blocked,
    missing,
    notInspected,
    message: blocked ? PUBLIC_RELEASE_BLOCKED_MESSAGE : SIGNING_INPUTS_PRESENT_MESSAGE
  };
}

function readSigningIdentities(platform) {
  if (platform !== "darwin") return { inspected: false, reason: "host_is_not_macos" };
  const listing = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8", timeout: 20000 });
  if (listing.error || listing.status !== 0 || typeof listing.stdout !== "string") return { inspected: false, reason: "security_tool_unavailable" };
  return { inspected: true, developerIdApplication: developerIdApplicationCount(listing.stdout) };
}

function readReleaseWorkflow() {
  try {
    return readFileSync(resolve(ROOT, RELEASE_WORKFLOW), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function main(argv) {
  if (argv.length > 0) throw new Error("This preflight reads the host and the repository and takes no options.");
  const receipt = buildReleaseSigningPreflight({
    platform: process.platform,
    identities: readSigningIdentities(process.platform),
    environment: process.env,
    workflow: readReleaseWorkflow()
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[morrow release signing preflight] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
