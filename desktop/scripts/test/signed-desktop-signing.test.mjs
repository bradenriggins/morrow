import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifySignedMacDiskImage, verifySignedUpdateArtifacts, isSignedPackageSigning, signedSigningState, verifySignedMacApp, verifySignedWindowsArtifact } from "../lib/signed-desktop-signing.mjs";

const identity = "Authority=Developer ID Application: Example Owner (AB12345678)\nTeamIdentifier=AB12345678\n";
test("signed receipts accept only the exact verified mode for their target", () => {
  for (const target of ["darwin-arm64", "win32-x64"]) {
    assert.equal(isSignedPackageSigning(signedSigningState(target), target), true);
    assert.equal(isSignedPackageSigning({ ...signedSigningState(target), automaticUpdates: false }, target), false);
    assert.equal(isSignedPackageSigning(signedSigningState(target), target === "darwin-arm64" ? "win32-x64" : "darwin-arm64"), false);
  }
});

test("Mac verification requires strict integrity, Developer ID, staple, and Gatekeeper acceptance", () => {
  const calls = [];
  verifySignedMacApp("/tmp/example.app", (command, args) => { calls.push([command, args]); return args.includes("-dvvv") ? identity : ""; });
  assert.deepEqual(calls, [
    ["/usr/bin/codesign", ["--verify", "--deep", "--strict", "/tmp/example.app"]],
    ["/usr/bin/codesign", ["-dvvv", "/tmp/example.app"]],
    ["/usr/bin/xcrun", ["stapler", "validate", "/tmp/example.app"]],
    ["/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", "/tmp/example.app"]]
  ]);
  for (const failed of ["--verify", "stapler", "--assess"]) {
    assert.throws(() => verifySignedMacApp("/tmp/example.app", (command, args) => {
      if (args.includes(failed)) throw new Error("verification rejected");
      return args.includes("-dvvv") ? identity : "";
    }), /verification rejected/);
  }
  assert.throws(() => verifySignedMacApp("/tmp/example.app", () => "Signature=adhoc\nTeamIdentifier=not set\n"), /no Developer ID/);
});

test("Windows verification passes paths through environment and propagates trust failures", () => {
  const file = "C:\\Example's folder\\Morrow.exe";
  const previous = process.env.MORROW_VERIFY_SIGNED_FILE;
  verifySignedWindowsArtifact(file, (command, args) => {
    assert.equal(command, "powershell.exe");
    assert.equal(process.env.MORROW_VERIFY_SIGNED_FILE, file);
    assert.match(args.at(-1), /Get-AuthenticodeSignature/);
    assert.match(args.at(-1), /Status -ne 'Valid'/);
    assert.equal(args.at(-1).includes(file), false);
  });
  assert.equal(process.env.MORROW_VERIFY_SIGNED_FILE, previous);
  assert.throws(() => verifySignedWindowsArtifact(file, () => { throw new Error("untrusted"); }), /untrusted/);
  assert.equal(process.env.MORROW_VERIFY_SIGNED_FILE, previous);
});


test("signed update metadata is bound to the exact bytes and rejects changed or duplicate files", (t) => {
  const root = mkdtempSync(join(tmpdir(), "morrow-signed-metadata-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const content = "version: 1.0.14\n";
  writeFileSync(join(root, "latest-mac.yml"), content);
  const receipt = { target: "darwin-arm64", artifacts: [{ name: "Morrow-1.0.14-mac-arm64.zip" }],
    updateArtifacts: [{ name: "latest-mac.yml", sha256: createHash("sha256").update(content).digest("hex") }] };
  verifySignedUpdateArtifacts(receipt, root);
  assert.throws(() => verifySignedUpdateArtifacts({ ...receipt, updateArtifacts: [...receipt.updateArtifacts, ...receipt.updateArtifacts] }, root), /missing generated/);
  writeFileSync(join(root, "latest-mac.yml"), "changed");
  assert.throws(() => verifySignedUpdateArtifacts(receipt, root), /changed after packaging/);
});

test("signed packaging refuses missing credentials before any build or network request", (t) => {
  const root = mkdtempSync(join(tmpdir(), "morrow-signed-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "package");
  const script = fileURLToPath(new URL("../package-mcp-bundle.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--target", "darwin-arm64", "--signed-release", "--output", output], { env: {}, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Signed release inputs are incomplete/);
  assert.equal(existsSync(output), false);
  const conflicting = spawnSync(process.execPath, [script, "--signed-release", "--unsigned-release", "--output", output], { env: {}, encoding: "utf8", timeout: 10000 });
  assert.equal(conflicting.status, 2);
  assert.match(conflicting.stderr, /Choose one distribution mode/);
});


test("the final disk image itself requires a Developer ID signature, staple and Gatekeeper open acceptance", () => {
  const calls = [];
  verifySignedMacDiskImage("/tmp/release.dmg", (command, args) => { calls.push([command, args]); return args.includes("-dvvv") ? identity : ""; });
  assert.deepEqual(calls.at(-1), ["/usr/sbin/spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", "/tmp/release.dmg"]]);
  assert.ok(calls.some(([, args]) => args.join(" ") === "stapler validate /tmp/release.dmg"));
  assert.throws(() => verifySignedMacDiskImage("/tmp/release.dmg", () => "Signature=adhoc"), /no Developer ID/);
});
