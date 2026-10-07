import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

export function signedSigningState(target) {
  return { mode: "signed_public_release", target, publicRelease: true, automaticUpdates: true,
    artifactSignature: target === "darwin-arm64" ? "developer_id_notarized" : "authenticode_valid" };
}

export function isSignedPackageSigning(value, target) {
  return isDeepStrictEqual(value, signedSigningState(target));
}

function execute(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 120_000 });
  if (result.error || result.status !== 0) throw new Error(`Signed artifact verification failed: ${command} (exit ${result.status ?? "unknown"}).`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

export function verifySignedMacApp(app, run = execute) {
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  const identity = run("/usr/bin/codesign", ["-dvvv", app]);
  if (!/^Authority=Developer ID Application: /m.test(identity) || !/^TeamIdentifier=(?!not set)[A-Z0-9]+$/m.test(identity)) {
    throw new Error("The signed Mac artifact has no Developer ID Application identity.");
  }
  run("/usr/bin/xcrun", ["stapler", "validate", app]);
  run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", app]);
}

export function verifySignedMacDiskImage(diskImage, run = execute) {
  run("/usr/bin/codesign", ["--verify", "--strict", diskImage]);
  const identity = run("/usr/bin/codesign", ["-dvvv", diskImage]);
  if (!/^Authority=Developer ID Application: /m.test(identity)) throw new Error("The disk image has no Developer ID signature.");
  run("/usr/bin/xcrun", ["stapler", "validate", diskImage]);
  run("/usr/sbin/spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", diskImage]);
}

export function verifySignedMacArtifacts({ diskImage, archive }) {
  if (process.platform !== "darwin") throw new Error("Signed Mac artifact verification requires macOS.");
  verifySignedMacDiskImage(diskImage);
  const root = mkdtempSync(join(tmpdir(), "morrow-signed-artifact-"));
  const mount = join(root, "mount");
  mkdirSync(mount);
  let mounted = false;
  try {
    execute("/usr/bin/hdiutil", ["attach", diskImage, "-readonly", "-nobrowse", "-mountpoint", mount]);
    mounted = true;
    const apps = readdirSync(mount).filter((name) => name.endsWith(".app"));
    if (apps.length !== 1) throw new Error("The signed disk image must contain exactly one app.");
    verifySignedMacApp(join(mount, apps[0]));
    const extracted = join(root, "zip");
    execute("/usr/bin/ditto", ["-x", "-k", archive, extracted]);
    const zippedApps = readdirSync(extracted).filter((name) => name.endsWith(".app"));
    if (zippedApps.length !== 1) throw new Error("The signed archive must contain exactly one app.");
    verifySignedMacApp(join(extracted, zippedApps[0]));
  } finally {
    if (mounted) execute("/usr/bin/hdiutil", ["detach", mount]);
    rmSync(root, { recursive: true, force: true });
  }
}

export function verifySignedWindowsArtifact(file, run = execute) {
  if (process.platform !== "win32" && run === execute) throw new Error("Authenticode verification requires Windows.");
  const script = "$s = Get-AuthenticodeSignature -LiteralPath $env:MORROW_VERIFY_SIGNED_FILE; if ($s.Status -ne 'Valid' -or !$s.SignerCertificate) { exit 1 }";
  const previous = process.env.MORROW_VERIFY_SIGNED_FILE;
  process.env.MORROW_VERIFY_SIGNED_FILE = file;
  try { run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]); }
  finally {
    if (previous === undefined) delete process.env.MORROW_VERIFY_SIGNED_FILE;
    else process.env.MORROW_VERIFY_SIGNED_FILE = previous;
  }
}


export function verifySignedUpdateArtifacts(receipt, directory) {
  const metadata = receipt.target === "darwin-arm64" ? "latest-mac.yml" : "latest.yml";
  const entries = receipt.updateArtifacts;
  if (!Array.isArray(entries) || entries.filter((entry) => entry.name === metadata).length !== 1) {
    throw new Error("Signed package receipt is missing generated update metadata.");
  }
  const names = new Set();
  for (const entry of entries) {
    if (typeof entry?.name !== "string" || basename(entry.name) !== entry.name || names.has(entry.name)
      || !/^[0-9a-f]{64}$/.test(entry.sha256 || "")
      || (entry.name !== metadata && !receipt.artifacts.some((artifact) => entry.name === `${artifact.name}.blockmap`))) {
      throw new Error("Signed update artifact identity is invalid.");
    }
    names.add(entry.name);
    const file = join(directory, entry.name);
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || createHash("sha256").update(readFileSync(file)).digest("hex") !== entry.sha256) {
      throw new Error("Generated signed update artifact changed after packaging.");
    }
  }
}
