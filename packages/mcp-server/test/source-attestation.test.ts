import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SourceAttestationError,
  verifyLocalGitSourceAttestation,
} from "../src/source-attestation.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

async function committedRepository(): Promise<{
  root: string;
  revision: string;
  dispose: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "morrow-source-attestation-"));
  git(root, "init");
  git(root, "config", "user.name", "Morrow Test");
  git(root, "config", "user.email", "morrow-test@example.invalid");
  await writeFile(join(root, "source.txt"), "first\n", "utf8");
  git(root, "add", "source.txt");
  git(root, "commit", "-m", "fixture");
  return {
    root,
    revision: git(root, "rev-parse", "HEAD"),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

describe("verifyLocalGitSourceAttestation", () => {
  it("binds a donor to its exact local Git revision without returning its path", async () => {
    const fixture = await committedRepository();
    try {
      const evidence = verifyLocalGitSourceAttestation(
        "meridian",
        "example-owner/example-attestation-repo",
        {
          kind: "local-git",
          root: fixture.root,
          expectedRevision: fixture.revision,
          requireTrackedClean: true,
          expectedToolCount: 205,
        },
        () => new Date("2026-09-03T22:10:00.000Z"),
      );
      expect(evidence).toMatchObject({
        schema: "morrow.source-attestation.v1",
        verified: true,
        sourceId: "meridian",
        repository: "example-owner/example-attestation-repo",
        expectedRevision: fixture.revision,
        actualRevision: fixture.revision,
        trackedClean: true,
        expectedToolCount: 205,
        verifiedAt: "2026-09-03T22:10:00.000Z",
      });
      expect(evidence.rootDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(evidence)).not.toContain(fixture.root);
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses a different revision and tracked donor changes", async () => {
    const fixture = await committedRepository();
    try {
      expect(() => verifyLocalGitSourceAttestation(
        "meridian",
        undefined,
        {
          kind: "local-git",
          root: fixture.root,
          expectedRevision: "f".repeat(40),
          requireTrackedClean: true,
        },
      )).toThrowError(SourceAttestationError);

      await writeFile(join(fixture.root, "source.txt"), "changed\n", "utf8");
      expect(() => verifyLocalGitSourceAttestation(
        "meridian",
        undefined,
        {
          kind: "local-git",
          root: fixture.root,
          expectedRevision: fixture.revision,
          requireTrackedClean: true,
        },
      )).toThrow(/tracked worktree changes/);

      expect(verifyLocalGitSourceAttestation(
        "meridian",
        undefined,
        {
          kind: "local-git",
          root: fixture.root,
          expectedRevision: fixture.revision,
          requireTrackedClean: false,
          allowedTrackedPaths: ["source.txt"],
        },
      )).toMatchObject({ verified: true, trackedClean: false });
    } finally {
      await fixture.dispose();
    }
  });
});
