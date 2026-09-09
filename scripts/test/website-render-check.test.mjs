import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RENDER_WIDTHS, runWebsiteRenderCheck } from "../website-render-check.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const WEBSITE = join(ROOT, "website");

const summarize = (result) => result.violations.map((v) => `${v.route} @${v.width}px ${v.kind} ${v.element}: ${v.detail}`);

test("every served page renders at every tested width with no horizontal overflow", { timeout: 320_000 }, async () => {
  const result = await runWebsiteRenderCheck({ root: WEBSITE });
  assert.equal(result.renders.length, result.widths.length * new Set(result.renders.map((r) => r.route)).size);
  assert.deepEqual(summarize(result), [], "a rendered page must not scroll sideways, clip or spill content, or hang past its container");
});

test("the render check fails on the hero overflow it was hardened for", { timeout: 320_000 }, async () => {
  // Recreate the pre-fix stylesheet in a scratch copy of the site: drop the max-width 400px block
  // that stacks the hero buttons into one column. The two-column grid at 600px then squeezes the
  // nowrap secondary button again, exactly as it did when the defect shipped.
  const scratch = mkdtempSync(join(tmpdir(), "website-render-defect-"));
  try {
    cpSync(WEBSITE, scratch, { recursive: true });
    const stylesPath = join(scratch, "styles.css");
    const styles = readFileSync(stylesPath, "utf8");
    const withoutFix = styles.replace(/\n\/\* Two hero buttons[\s\S]*?@media \(max-width: 400px\) \{\n  \.hero-actions \{ grid-template-columns: 1fr; \}\n\}\n/, "\n");
    assert.notEqual(withoutFix, styles, "the shipped stylesheet carries the one-column hero stack the scratch copy removes");
    writeFileSync(stylesPath, withoutFix);

    const result = await runWebsiteRenderCheck({ root: scratch, widths: [320, 390], routes: ["/"] });
    const at = (width) => result.violations.filter((v) => v.width === width);

    // At 320px the squeezed row pushed the whole document sideways.
    assert.ok(at(320).some((v) => v.kind === "page-scroll"), `320px must scroll sideways again: ${JSON.stringify(summarize(result))}`);
    // At 390px the document did not scroll, which is why the old check passed: the failure is the
    // row and the button each carrying more content than their own boxes, in plain sight.
    const heroRow = at(390).find((v) => v.kind === "content-overflow" && v.element.includes("hero-actions"));
    assert.ok(heroRow, `390px must flag the hero row: ${JSON.stringify(summarize(result))}`);
    const secondary = at(390).find((v) => v.kind === "content-overflow" && v.element.includes("button-secondary"));
    assert.ok(secondary, `390px must flag the secondary button: ${JSON.stringify(summarize(result))}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
