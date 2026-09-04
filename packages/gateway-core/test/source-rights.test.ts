import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validatePublicAssemblyInputs } from "../src/index.js";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("public source-rights validation", () => {
  it("PRIV-06 requires an exact cleared record and rejects private markers", () => {
    const bytes = Buffer.from("export const canvasTool = true;\n");
    const manifest = {
      schema: "morrow.source-rights.v1",
      files: [{
        path: "packages/public/canvas-tool.ts",
        sha256: sha256(bytes),
        disposition: "clean_reimplementation",
        review: "rights-review: public contract implementation",
      }],
    };
    expect(() => validatePublicAssemblyInputs(manifest, [{ path: "packages/public/canvas-tool.ts", bytes }])).not.toThrow();
    const privateBytes = Buffer.from("const example-kitInternal = true;\n");
    expect(() => validatePublicAssemblyInputs({
      ...manifest,
      files: [{ ...manifest.files[0], sha256: sha256(privateBytes) }],
    }, [{
      path: "packages/public/canvas-tool.ts",
      bytes: privateBytes,
    }])).toThrow(/private marker/);
    expect(() => validatePublicAssemblyInputs({
      ...manifest,
      files: [{ ...manifest.files[0], disposition: "rights_hold" }],
    }, [{ path: "packages/public/canvas-tool.ts", bytes }])).toThrow(/blocked disposition/);
  });

  it("requires pinned OFL evidence for redistributable third-party source", () => {
    const font = Buffer.from("font-bytes");
    const license = Buffer.from("SIL Open Font License 1.1\n");
    const manifest = {
      schema: "morrow.source-rights.v1",
      files: [{
        path: "connector/brand/FONT-LICENSE.txt",
        sha256: sha256(license),
        disposition: "third_party_redistributable",
        review: "rights-review: retained OFL notice",
        thirdParty: {
          assetSha256: sha256(license),
          copyright: "Copyright holder",
          license: "SIL-OFL-1.1",
          licensePath: "connector/brand/FONT-LICENSE.txt",
          licenseSha256: sha256(license),
          sourceUrl: "https://openfontlicense.org",
        },
      }, {
        path: "connector/brand/font.woff2",
        sha256: sha256(font),
        disposition: "third_party_redistributable",
        review: "rights-review: retained OFL notice",
        thirdParty: {
          assetSha256: sha256(font),
          copyright: "Copyright holder",
          license: "SIL-OFL-1.1",
          licensePath: "connector/brand/FONT-LICENSE.txt",
          licenseSha256: sha256(license),
          sourceUrl: "https://fonts.example.invalid/font",
        },
      }],
    };
    expect(() => validatePublicAssemblyInputs(manifest, [
      { path: "connector/brand/FONT-LICENSE.txt", bytes: license },
      { path: "connector/brand/font.woff2", bytes: font },
    ])).not.toThrow();
    expect(() => validatePublicAssemblyInputs({
      ...manifest,
      files: [{ ...manifest.files[0] }, {
        ...manifest.files[1],
        thirdParty: { ...manifest.files[1].thirdParty, assetSha256: sha256(license) },
      }],
    }, [{ path: "connector/brand/font.woff2", bytes: font }])).toThrow(/asset digest/);
  });
});
