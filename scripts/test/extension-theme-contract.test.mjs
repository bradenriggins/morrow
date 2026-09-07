import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { captureBridgeRelease } from "../package-mcp-bundle.mjs";
import { serveBrandAsset } from "../../packages/bridge-loopback/dist/brand.js";

/**
 * `connector/extension/brand/theme.css` is the only place Morrow defines its tokens, and every
 * Morrow-owned surface loads it: the popup, onboarding, settings, the pairing pages the local bridge
 * serves, and the review and result pages the approval server serves. These tests recompute the
 * focus-ring contrast from the tokens themselves, so a palette edit that makes the ring hard to see
 * fails here instead of on an instructor's screen, and they keep
 * `docs/brand/MORROW-BRAND.md` describing the file that ships.
 */
const repo = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, repo), "utf8");

const THEME_PATH = "connector/extension/brand/theme.css";
const BRAND_DOC_PATH = "docs/brand/MORROW-BRAND.md";
const BRAND_DIRECTORY = "connector/extension/brand/";
const LOOPBACK_BRAND_PATH = "packages/bridge-loopback/src/brand.ts";

const theme = read(THEME_PATH);
const brandDocument = read(BRAND_DOC_PATH);

/** Every stylesheet that loads the shared tokens. */
const COMPONENT_STYLESHEETS = [
  "connector/extension/brand/review.css",
  "connector/extension/popup/popup.css",
  "connector/extension/onboarding/onboarding.css",
  "connector/extension/settings/settings.css",
  "installer/renderer/styles.css",
].filter((path) => existsSync(new URL(path, repo)));

/** The stylesheets the brand owns. Other lanes own the component files listed above. */
const BRAND_STYLESHEETS = [THEME_PATH, "connector/extension/brand/review.css"];

/**
 * A brand file that ships without any surface naming it. The SIL Open Font License requires the
 * license text to travel with the font, so `Manrope-OFL.txt` ships beside `Manrope-variable.ttf`.
 * Nothing else belongs here: an unreferenced file is bytes in every install that no one receives.
 */
const SHIPPED_WITHOUT_A_REFERENCE = new Map([["Manrope-OFL.txt", "Manrope-variable.ttf"]]);

// --- Tokens and contrast -------------------------------------------------------------------------

/** The `:root` custom properties of one section of the file. */
function tokens(source) {
  const block = source.match(/:root\s*\{([^}]*)\}/);
  assert.ok(block, "expected a :root block");
  return Object.fromEntries([...block[1].matchAll(/(--[a-z-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}

const [lightSource, darkSource] = theme.split("@media (prefers-color-scheme: dark)");
assert.ok(darkSource, `${THEME_PATH} must define a dark palette`);
const light = tokens(lightSource);
const dark = { ...light, ...tokens(darkSource) };
const palettes = { light, dark };

const channels = (hex) => {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `${hex} is not a six-digit hex colour`);
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};
const linear = (channel) => {
  const part = channel / 255;
  return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
};
const luminance = (rgb) => 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
/** The WCAG 2.x contrast ratio of two colours. */
const contrast = (first, second) => {
  const [high, low] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
};
/** `color-mix(in srgb, <top> <share>, transparent)` painted over `under`. */
const mix = (top, under, share) => channels(top).map((value, index) => value * share + channels(under)[index] * (1 - share));
const round = (value) => Math.round(value * 100) / 100;

const focusRule = theme.match(/:focus-visible\s*\{([^}]*)\}/);
assert.ok(focusRule, `${THEME_PATH} must define a :focus-visible rule`);
const focusDeclarations = focusRule[1];
const haloShare = Number(focusDeclarations.match(/color-mix\(in srgb, var\(--focus\) (\d+)%, transparent\)/)?.[1]) / 100;

const SURFACES = ["--page", "--raised", "--sunken"];
/** Every comparison the brand document records, with the colour each one measures against. */
const comparisons = [
  ...SURFACES.map((token) => ({ label: `\`${token}\``, isSurface: true, against: (palette) => channels(palette[token]) })),
  ...SURFACES.map((token) => ({ label: `halo over \`${token}\``, isSurface: true, against: (palette) => mix(palette["--focus"], palette[token], haloShare) })),
  { label: "`--ink`", isSurface: false, against: (palette) => channels(palette["--ink"]) },
];

test("the focus ring keeps 3:1 against every surface it can sit on, in both themes", () => {
  assert.match(focusDeclarations, /outline:\s*(\d+)px solid var\(--focus\)/, `${THEME_PATH} must draw the focus ring in --focus`);
  assert.ok(Number(focusDeclarations.match(/outline:\s*(\d+)px/)[1]) >= 2, "the focus ring must be at least 2 px thick");
  assert.ok(haloShare > 0, `${THEME_PATH} must mix the focus halo from --focus`);

  const failures = [];
  for (const [name, palette] of Object.entries(palettes)) {
    for (const comparison of comparisons.filter((comparison) => comparison.isSurface)) {
      const ratio = contrast(channels(palette["--focus"]), comparison.against(palette));
      if (ratio < 3) failures.push(`${name}: focus ring against ${comparison.label} is ${round(ratio)}:1`);
    }
  }
  assert.deepEqual(failures, [], "a focus ring below 3:1 against the surface behind it is not identifiable");
});

test("the brand document records the contrast the tokens actually produce", () => {
  const rows = new Map(
    [...brandDocument.matchAll(/^\| (halo over `--[a-z]+`|`--[a-z]+`) \| ([\d.]+):1 \| ([\d.]+):1 \|$/gm)]
      .map(([, label, lightRatio, darkRatio]) => [label, { light: Number(lightRatio), dark: Number(darkRatio) }]),
  );
  assert.deepEqual(
    [...rows.keys()],
    comparisons.map((comparison) => comparison.label),
    `${BRAND_DOC_PATH} must record one row per comparison, in order`,
  );
  const drift = [];
  for (const comparison of comparisons) {
    for (const [name, palette] of Object.entries(palettes)) {
      const measured = round(contrast(channels(palette["--focus"]), comparison.against(palette)));
      const recorded = rows.get(comparison.label)[name];
      if (measured !== recorded) drift.push(`${name} ${comparison.label}: document says ${recorded}:1, tokens give ${measured}:1`);
    }
  }
  assert.deepEqual(drift, [], `${BRAND_DOC_PATH} and ${THEME_PATH} disagree`);
});

test("--ink stays a text colour, so the focus ring never sits on it", () => {
  // The recorded --ink ratios are below 3:1. They are safe only while no surface is painted in ink.
  const painted = [];
  for (const path of [THEME_PATH, ...COMPONENT_STYLESHEETS]) {
    const source = read(path);
    for (const [index, line] of source.split("\n").entries()) {
      if (/background[^;{}]*var\(--(?:ink|text)\)/.test(line)) painted.push(`${path}:${index + 1} ${line.trim()}`);
    }
  }
  assert.deepEqual(painted, [], "a surface painted in --ink would carry a focus ring below 3:1");
});

// --- Control size and reduced transparency ---------------------------------------------------------

/** Flat `selector { declarations }` pairs. A media query wrapper is skipped, its rules are not. */
function rules(source) {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, declarations]) => ({ selector: selector.trim(), declarations }))
    .filter((rule) => !rule.selector.startsWith("@"));
}

test("no brand stylesheet drops a button below the 44 px floor", () => {
  assert.match(theme, /button\s*\{[^}]*min-height:\s*44px/, `${THEME_PATH} must set the 44 px button floor`);
  assert.match(brandDocument, /at least 44 px high/, `${BRAND_DOC_PATH} must state the 44 px rule so it is checkable`);

  const short = [];
  for (const path of BRAND_STYLESHEETS) {
    for (const rule of rules(read(path))) {
      if (!/\bbutton\b/.test(rule.selector)) continue;
      for (const [, property, size] of rule.declarations.matchAll(/\b((?:min-)?height):\s*(\d+)px/g)) {
        if (Number(size) < 44) short.push(`${path}: ${rule.selector} sets ${property}: ${size}px`);
      }
    }
  }
  assert.deepEqual(short, [], "a button below 44 px is hard to hit on a touch screen or with a tremor");
});

test("reduced transparency removes the translucent paint and keeps every surface", () => {
  const start = theme.indexOf("@media (prefers-reduced-transparency: reduce)");
  assert.ok(start >= 0, `${THEME_PATH} must answer prefers-reduced-transparency`);
  let depth = 0;
  let block = "";
  for (let index = theme.indexOf("{", start); index < theme.length; index += 1) {
    if (theme[index] === "{") depth += 1;
    else if (theme[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        block = theme.slice(theme.indexOf("{", start) + 1, index);
        break;
      }
    }
  }
  assert.ok(block, "the reduced-transparency block is not closed");
  for (const token of [...SURFACES, "--ink", "--border"]) {
    assert.doesNotMatch(
      block,
      new RegExp(`${token}:`),
      // Flattening the surfaces onto one colour takes the only boundary from a chip or step marker
      // that has no border. Reduced transparency asks for opaque paint, not for fewer surfaces.
      `${THEME_PATH} must not redefine ${token} for reduced transparency`,
    );
  }
  assert.match(block, /--shadow:\s*none/, "reduced transparency must drop the translucent shadow");
  assert.match(block, /box-shadow:\s*none/, "reduced transparency must drop the translucent focus halo");
});

// --- Shipped brand assets ---------------------------------------------------------------------------

test("every file in the brand directory is one a shipped surface asks for", () => {
  const brandFiles = readdirSync(new URL(BRAND_DIRECTORY, repo)).sort();
  const extensionRoot = new URL("connector/extension/", repo);
  const references = [
    ...readdirSync(extensionRoot, { recursive: true })
      .filter((name) => /\.(?:html|css|js|json)$/.test(name))
      .map((name) => readFileSync(new URL(name, extensionRoot), "utf8")),
    read(LOOPBACK_BRAND_PATH),
  ].join("\n");

  const unreferenced = brandFiles.filter((name) => {
    const font = SHIPPED_WITHOUT_A_REFERENCE.get(name);
    if (font) return !brandFiles.includes(font);
    return !references.includes(name);
  });
  assert.deepEqual(unreferenced, [], "an unreferenced brand file is weight in every install that nothing displays");

  const packaged = captureBridgeRelease().files
    .filter((file) => file.path.startsWith("brand/"))
    .map((file) => file.path.slice("brand/".length))
    .sort();
  assert.deepEqual(packaged, brandFiles, "the packaged file set and the brand directory must agree");
});

test("the local bridge serves every brand asset it maps, and nothing else", () => {
  const source = read(LOOPBACK_BRAND_PATH);
  const map = source.match(/const assets: Record<string, string> = \{([\s\S]*?)\};/);
  assert.ok(map, `${LOOPBACK_BRAND_PATH} must declare the served asset map`);
  const declared = [...map[1].matchAll(/"([^"]+)":/g)].map(([, name]) => name).sort();
  const requested = [...source.matchAll(/\/morrow-brand\/([\w.-]+)/g)].map(([, name]) => name);
  // theme.css loads the font itself, so the font is requested by the stylesheet rather than by a page.
  const fromStylesheets = [...read(THEME_PATH).matchAll(/url\("([\w.-]+)"\)/g)].map(([, name]) => name);
  assert.deepEqual(declared, [...new Set([...requested, ...fromStylesheets])].sort(), "the served map and the pages must ask for the same files");

  for (const name of declared) {
    const written = [];
    const served = serveBrandAsset(`/morrow-brand/${name}`, {
      writeHead(status, headers) {
        written.push({ status, headers });
      },
      end(bytes) {
        written.push({ bytes: bytes.byteLength });
      },
    });
    assert.equal(served, true, `${name} is mapped but was not served; rebuild @morrow/bridge-loopback if its source changed`);
    assert.equal(written[0].status, 200);
    assert.ok(written[1].bytes > 0, `${name} was served as an empty file`);
  }
  assert.equal(serveBrandAsset("/morrow-brand/morrow-wordmark.png", {}), false, "a name that is not mapped must not be read from disk");
});
