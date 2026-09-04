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
});
