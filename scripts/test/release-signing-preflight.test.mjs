import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MACOS_IDENTITY_INPUT,
  MACOS_SIGNING_VARIABLES,
  PUBLIC_RELEASE_BLOCKED_MESSAGE,
  SIGNING_INPUTS_PRESENT_MESSAGE,
  WINDOWS_SIGNING_VARIABLES,
  WORKFLOW_SECRET_INPUT,
  buildReleaseSigningPreflight,
  developerIdApplicationCount,
  referencedSecretNames
} from "../release-signing-preflight.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const script = join(root, "scripts/release-signing-preflight.mjs");
const workflowPath = ".github/workflows/desktop-release.yml";
const releaseWorkflow = readFileSync(join(root, workflowPath), "utf8");

/**
 * A keychain listing shaped like the one `security find-identity -v -p codesigning` prints on a Mac
 * that holds a Developer ID. Only the middle row is a Developer ID Application identity.
 */
const IDENTITY_LISTING = [
  "  1) 1F3A9C4D5E6B7A8C9D0E1F2A3B4C5D6E7F8A9B0C \"Apple Development: release.owner@example.com (AB12CD34EF)\"",
  "  2) 2A4B6C8D0E2F4A6B8C0D2E4F6A8B0C2D4E6F8A0B \"Developer ID Application: Example Owner (AB12CD34EF)\"",
  "  3) 3B5C7D9E1F3A5B7C9D1E3F5A7B9C1D3E5F7A9B1C \"Developer ID Installer: Example Owner (AB12CD34EF)\"",
  "     3 valid identities found",
  ""
].join("\n");

const EMPTY_IDENTITY_LISTING = "     0 valid identities found\n";

/** Secret-shaped values, so a receipt that copies any input value out fails these tests. */
const SECRET_ENVIRONMENT = Object.freeze({
  CSC_LINK: "MIIKlQIBAzCCCl8GCSqGSIb3DQEHAaCCClAEggpMMIIKSDCCBP8GCSqGSIb3DQEHBqCCBPAwggTsAgEAMIIE5QYJKoZIhvcNAQcB",
  CSC_KEY_PASSWORD: "e3f1c8d90b7a45268134fa77bd0e5c92",
  APPLE_ID: "release.owner@example.com",
  APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh-ijkl-mnop",
  APPLE_TEAM_ID: "AB12CD34EF",
  WIN_CSC_LINK: "MIIJqgIBAzCCCWYGCSqGSIb3DQEHAaCCCVcEgglTMIIJTzCCBgAGCSqGSIb3DQEHAaCCBfEEggXtMIIF6TCCBeUGCyqGSIb3DQEM",
  WIN_CSC_KEY_PASSWORD: "3f6d2a1b9c8e47d05f2a6b3c8d9e0f1a",
  CSC_NAME: "CN=Example Owner, OU=AB12CD34EF, O=Example Owner, C=US"
});

const SIGNED_WORKFLOW = [
  "      - name: Package the signed disk image",
  "        env:",
  "          CSC_LINK: ${{ secrets.CSC_LINK }}",
  "          CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}",
  "          APPLE_ID: ${{ secrets.APPLE_ID }}",
  "          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}",
  "          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}",
  "          WIN_CSC_LINK: ${{ secrets.WIN_CSC_LINK }}",
  "          WIN_CSC_KEY_PASSWORD: ${{ secrets.WIN_CSC_KEY_PASSWORD }}",
  "          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
  ""
].join("\n");

/** Every string the receipt actually carries, so a secret check reads values and not field names. */
function stringValues(value, found = []) {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const entry of value) stringValues(entry, found);
  else if (value && typeof value === "object") for (const entry of Object.values(value)) stringValues(entry, found);
  return found;
}

/**
 * The receipt must be readable by anyone who can read a build log. No input value may survive into
 * it, and no value may carry the shape of a certificate, a key, a token, or an address.
 */
function assertCarriesNoSecret(receipt, presentInputs) {
  const serialized = JSON.stringify(receipt);
  for (const value of presentInputs) {
    assert.ok(value.length >= 10, "a secret fixture has to be long enough for this check to mean anything");
    assert.ok(!serialized.includes(value), `the receipt copied an input value: ${value.slice(0, 6)}…`);
  }
  for (const shape of [/@/, /CN=/, /-----BEGIN/, /PRIVATE KEY/]) {
    assert.doesNotMatch(serialized, shape, `the receipt carries ${shape} somewhere in its keys or values`);
  }
  for (const value of stringValues(receipt)) {
    assert.doesNotMatch(value, /[A-Za-z0-9+]{24,}/, `a receipt value is shaped like an opaque token: ${value}`);
  }
}

test("a Mac with no Developer ID identity and no signing variables blocks a public release and names every missing input", () => {
  const receipt = buildReleaseSigningPreflight({
    platform: "darwin",
    identities: { inspected: true, developerIdApplication: developerIdApplicationCount(EMPTY_IDENTITY_LISTING) },
    environment: {},
    workflow: releaseWorkflow
  });

  assert.equal(receipt.schema, "morrow.release-signing-preflight.v1");
  assert.equal(receipt.publicReleaseBlocked, true);
  assert.equal(receipt.mode, "unsigned_private_qa");
  assert.equal(receipt.message, PUBLIC_RELEASE_BLOCKED_MESSAGE);
  assert.deepEqual(receipt.missing, [
    MACOS_IDENTITY_INPUT,
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
    "WIN_CSC_LINK",
    "WIN_CSC_KEY_PASSWORD",
    WORKFLOW_SECRET_INPUT
  ]);
  assert.deepEqual(receipt.notInspected, []);
  assert.equal(receipt.macos.identities.developerIdApplication, 0);
  assert.deepEqual(Object.values(receipt.macos.environment), [false, false, false, false, false]);
  assert.deepEqual(Object.values(receipt.windows.environment), [false, false]);
  assertCarriesNoSecret(receipt, []);
});


test("a host holding every signing input is not blocked, and the receipt still carries no identity, certificate, address, or variable value", () => {
  const receipt = buildReleaseSigningPreflight({
    platform: "darwin",
    identities: { inspected: true, developerIdApplication: developerIdApplicationCount(IDENTITY_LISTING) },
    environment: SECRET_ENVIRONMENT,
    workflow: SIGNED_WORKFLOW
  });

  assert.equal(receipt.macos.identities.developerIdApplication, 1, "an Apple Development or Developer ID Installer row is not a Developer ID Application identity");
  assert.deepEqual(receipt.missing, []);
  assert.deepEqual(receipt.notInspected, []);
  assert.equal(receipt.publicReleaseBlocked, false);
  assert.equal(receipt.mode, "signing_inputs_present");
  assert.equal(receipt.message, SIGNING_INPUTS_PRESENT_MESSAGE);
  assert.equal(receipt.repository.referencesSigningSecret, true);
  assert.deepEqual(receipt.macos.environment, { CSC_LINK: true, CSC_KEY_PASSWORD: true, APPLE_ID: true, APPLE_APP_SPECIFIC_PASSWORD: true, APPLE_TEAM_ID: true });
  assert.deepEqual(receipt.windows.environment, { WIN_CSC_LINK: true, WIN_CSC_KEY_PASSWORD: true });

  assertCarriesNoSecret(receipt, [
    ...Object.values(SECRET_ENVIRONMENT),
    "1F3A9C4D5E6B7A8C9D0E1F2A3B4C5D6E7F8A9B0C",
    "2A4B6C8D0E2F4A6B8C0D2E4F6A8B0C2D4E6F8A0B",
    "Developer ID Application: Example Owner"
  ]);
});

test("a variable set to an empty string is not a present signing input", () => {
  const receipt = buildReleaseSigningPreflight({
    platform: "darwin",
    identities: { inspected: true, developerIdApplication: 1 },
    environment: { ...SECRET_ENVIRONMENT, APPLE_TEAM_ID: "  " },
    workflow: SIGNED_WORKFLOW
  });
  assert.equal(receipt.macos.environment.APPLE_TEAM_ID, false);
  assert.deepEqual(receipt.missing, ["APPLE_TEAM_ID"]);
  assert.equal(receipt.publicReleaseBlocked, true);
});

test("an identity list this host cannot read is reported as uninspected, never as absent", () => {
  const receipt = buildReleaseSigningPreflight({
    platform: "win32",
    identities: { inspected: false, reason: "host_is_not_macos" },
    environment: SECRET_ENVIRONMENT,
    workflow: SIGNED_WORKFLOW
  });
  assert.deepEqual(receipt.notInspected, [MACOS_IDENTITY_INPUT]);
  assert.deepEqual(receipt.missing, []);
  assert.equal(receipt.publicReleaseBlocked, true, "an input nobody could read here cannot clear a public release");
  assert.equal(receipt.macos.identities.inspected, false);
  assert.equal(receipt.macos.identities.reason, "host_is_not_macos");
  assert.equal(receipt.macos.identities.developerIdApplication, undefined);
  assertCarriesNoSecret(receipt, Object.values(SECRET_ENVIRONMENT));
});

test("the receipt refuses an inspection result it cannot describe exactly", () => {
  const inputs = { platform: "darwin", environment: {}, workflow: releaseWorkflow };
  assert.throws(
    () => buildReleaseSigningPreflight({ ...inputs, identities: { inspected: false, reason: "security: SecKeychainCopySearchList failed" } }),
    /must carry one of these reasons/
  );
  assert.throws(
    () => buildReleaseSigningPreflight({ ...inputs, identities: { inspected: true, developerIdApplication: "1) Developer ID Application" } }),
    /whole Developer ID Application count/
  );
});

test("clearing a signing variable in a shell step is not a repository secret reference", () => {
  assert.match(releaseWorkflow, /^\s+unset CSC_LINK /m, `this test reads ${workflowPath} for shell lines that clear signing variables`);
  assert.match(releaseWorkflow, /^\s+Remove-Item Env:WIN_CSC_LINK /m, `this test reads ${workflowPath} for shell lines that clear signing variables`);

  const receipt = buildReleaseSigningPreflight({
    platform: "darwin",
    identities: { inspected: true, developerIdApplication: 0 },
    environment: {},
    workflow: releaseWorkflow
  });
  assert.deepEqual(receipt.repository.referencedSecrets, referencedSecretNames(releaseWorkflow));
  assert.equal(receipt.repository.referencesSigningSecret, false, `${workflowPath} names signing variables only to clear them, which is not a secret reference`);
  assert.equal(receipt.repository.present, true);
  assert.ok(receipt.missing.includes(WORKFLOW_SECRET_INPUT));

  assert.deepEqual(referencedSecretNames(SIGNED_WORKFLOW), [
    "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_ID", "APPLE_TEAM_ID", "CSC_KEY_PASSWORD", "CSC_LINK", "GITHUB_TOKEN", "WIN_CSC_KEY_PASSWORD", "WIN_CSC_LINK"
  ]);
});

test("a repository without the release workflow reports the file as absent instead of guessing", () => {
  const receipt = buildReleaseSigningPreflight({
    platform: "darwin",
    identities: { inspected: true, developerIdApplication: 1 },
    environment: SECRET_ENVIRONMENT,
    workflow: null
  });
  assert.equal(receipt.repository.present, false);
  assert.deepEqual(receipt.repository.referencedSecrets, []);
  assert.deepEqual(receipt.missing, [WORKFLOW_SECRET_INPUT]);
});

test("the command runs on this host, prints one receipt, and exits 0 while a public release is blocked", () => {
  const environment = { ...process.env };
  for (const name of [...MACOS_SIGNING_VARIABLES, ...WINDOWS_SIGNING_VARIABLES]) delete environment[name];
  const run = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8", env: environment });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, "");
  assert.ok(run.stdout.endsWith("\n"));
  const receipt = JSON.parse(run.stdout);
  assert.equal(receipt.schema, "morrow.release-signing-preflight.v1");
  assert.equal(receipt.host.platform, process.platform);
  assert.equal(receipt.macos.identities.query, "security find-identity -v -p codesigning");
  assert.equal(receipt.publicReleaseBlocked, true);
  assert.equal(receipt.message, PUBLIC_RELEASE_BLOCKED_MESSAGE);
  assert.deepEqual(
    receipt.missing.filter((input) => input !== MACOS_IDENTITY_INPUT && input !== WORKFLOW_SECRET_INPUT),
    [...MACOS_SIGNING_VARIABLES, ...WINDOWS_SIGNING_VARIABLES]
  );
  if (process.platform === "darwin") {
    assert.equal(receipt.macos.identities.inspected, true, "security find-identity has to answer on macOS");
    assert.equal(typeof receipt.macos.identities.developerIdApplication, "number");
  } else {
    assert.deepEqual(receipt.notInspected, [MACOS_IDENTITY_INPUT]);
  }
  assertCarriesNoSecret(receipt, []);
});

test("the command takes no options and says so instead of reporting a partial answer", () => {
  const run = spawnSync(process.execPath, [script, "--check"], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /\[morrow release signing preflight\] This preflight reads the host and the repository and takes no options\./);
});

test("pnpm release:signing:preflight runs this script", () => {
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  assert.equal(scripts["release:signing:preflight"], "node scripts/release-signing-preflight.mjs");
});
