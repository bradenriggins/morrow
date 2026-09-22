import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

// `.better-web-ui.md` is a design-context file that UI tooling loads by filename convention. It held
// the retired September 4 direction (Google Sans Flex, violet actions, graphite text) long after
// `docs/brand/MORROW-BRAND.md` replaced it, so any agent that read it was misdirected. These tests
// keep the three brand sources agreeing: the design context, the brand document, and the tokens.
const repo = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, repo), "utf8");

const CONTEXT_PATH = ".better-web-ui.md";
const BRAND_PATH = "docs/brand/MORROW-BRAND.md";
const THEME_PATH = "connector/extension/brand/theme.css";

const context = read(CONTEXT_PATH);
const brand = read(BRAND_PATH);
const theme = read(THEME_PATH);

/** Every hex colour in a file, lowercased. Markdown headings (`# `) and SHA-256 digests do not match. */
const hexes = (text) => new Set((text.match(/#[0-9a-f]{3,8}\b/gi) ?? []).map((hex) => hex.toLowerCase()));

/**
 * Hex colours from the brand document's colour table only. The Knot section names the ribbon colours
 * `#6884FF` and `#CBDC74`, which live in `morrow-knot.svg` rather than in the token file, so table
 * rows are the fair comparison against `theme.css`.
 */
const brandTableHexes = hexes(brand.split("\n").filter((line) => line.trimStart().startsWith("|")).join("\n"));

const themeHexes = hexes(theme);

// The September 4 palette. `#ffffff` is in both directions, so it is not a retired value.
const RETIRED_COLOURS = ["#4931aa", "#171923", "#f5f6fa", "#e3e6ee", "#5f6375", "#101117", "#191b25", "#f4f4f7", "#bfb2ff"];

test("the design context introduces no colour the brand document and tokens do not define", () => {
  for (const hex of hexes(context)) {
    assert.ok(brandTableHexes.has(hex), `${CONTEXT_PATH} names ${hex}, which is not in the ${BRAND_PATH} colour table`);
    assert.ok(themeHexes.has(hex), `${CONTEXT_PATH} names ${hex}, which is not in ${THEME_PATH}`);
  }
  for (const hex of RETIRED_COLOURS) {
    assert.ok(!context.toLowerCase().includes(hex), `${CONTEXT_PATH} still carries the retired colour ${hex}`);
    assert.ok(!brandTableHexes.has(hex), `${BRAND_PATH} still carries the retired colour ${hex}`);
  }
});

test("the brand colour table matches the shipped tokens", () => {
  for (const hex of brandTableHexes) {
    assert.ok(themeHexes.has(hex), `${BRAND_PATH} names ${hex}, which no token in ${THEME_PATH} defines`);
  }
});

test("the design context names the shipped font family and no retired one", () => {
  const family = theme.match(/--font-sans:\s*"([^"]+)"/)?.[1];
  assert.ok(family, `${THEME_PATH} defines no --font-sans family`);
  assert.ok(brand.includes(`**${family}**`), `${BRAND_PATH} does not name ${family} as the type family`);
  assert.ok(context.includes(family), `${CONTEXT_PATH} does not name ${family}`);
  assert.ok(!/google\s*sans\s*flex/i.test(context), `${CONTEXT_PATH} still names Google Sans Flex`);
});

test("the design context requires the live-text wordmark beside the knot", () => {
  assert.match(brand, /live-text\s+[“"]morrow[”"]\s+wordmark/i);
  assert.match(context, /live-text\s+"morrow"\s+wordmark/i);
  // The retired direction banned live text: "Do not recreate it with normal text beside an icon."
  assert.ok(!/do not recreate/i.test(context), `${CONTEXT_PATH} still bans the live-text wordmark`);
});

test("the design context points at the brand document and the token file, and every path it names exists", () => {
  assert.ok(context.includes(BRAND_PATH), `${CONTEXT_PATH} must name ${BRAND_PATH} as the single source`);
  assert.ok(context.includes(THEME_PATH), `${CONTEXT_PATH} must name ${THEME_PATH} as the token source`);
  // A backticked token that holds a directory separator and ends in a file extension is a repository
  // path. Tokens such as `--accent` or a phrase like `light/dark` are not, and are skipped.
  const paths = (context.match(/`[^`]+`/g) ?? [])
    .map((token) => token.slice(1, -1))
    .filter((token) => /^[\w.-]+(?:\/[\w.-]+)+\.[a-z]{2,5}$/.test(token));
  assert.ok(paths.length >= 3, `${CONTEXT_PATH} names ${paths.length} repository paths; expected the brand, token, and knot files`);
  for (const path of paths) {
    assert.ok(existsSync(new URL(path, repo)), `${CONTEXT_PATH} names ${path}, which does not exist`);
  }
});

test("the five design principles are intact", () => {
  const section = context.split("### Design Principles")[1];
  assert.ok(section, `${CONTEXT_PATH} has no Design Principles section`);
  const principles = section.split("\n").filter((line) => /^\d+\. /.test(line)).map((line) => line.replace(/^\d+\. /, "").trim());
  assert.deepEqual(principles, [
    "Show the next useful action before technical details.",
    "Keep permission, changes, consequences, and uncertainty visible.",
    "Distinguish an active Morrow connection from a checked Canvas connection.",
    "Preserve exact requested values. Keep technical records in closed details.",
    "Use spacing and weight for hierarchy. Keep the established colors and density.",
  ]);
});
