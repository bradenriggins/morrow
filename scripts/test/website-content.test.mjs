import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import test from "node:test";
import { RETIRED_PHRASES } from "./lib/retired-claims.mjs";

// `website/` is gitignored (.gitignore:23) and `pnpm scripts:test` globs `scripts/test/*.test.mjs`,
// so this file runs in checkouts that do not hold the site. Every test below skips when the
// directory is absent instead of failing a clean clone.
const site = new URL("../../website/", import.meta.url);
const present = existsSync(site);
const skip = present ? false : "website/ is not present in this checkout";

/**
 * Words and phrases that must not appear anywhere in `website/`. The list lives in
 * `scripts/test/lib/retired-claims.mjs` so the site and the claim documents
 * (`scripts/test/product-claims.test.mjs`) retire the same phrases. Each entry is matched
 * case-insensitively against the raw HTML, so a phrase inside a meta tag or an attribute fails the
 * same way visible copy does.
 */
export const BANNED_PHRASES = RETIRED_PHRASES;

/**
 * Fixed release destinations the site may link to. Check each destination used by a page with
 * `MORROW_CHECK_EXTERNAL_LINKS=1 node --test scripts/test/website-content.test.mjs`.
 * Absolute URLs on the site's own origin are not listed here; they are checked against the page's
 * own route by the canonical and Open Graph test.
 */
export const EXTERNAL_LINK_ALLOWLIST = [
  "https://github.com/example-owner/morrow-downloads",
  "https://github.com/example-owner/morrow-downloads/releases/download/v1.0.0/Morrow-1.0.0-mac-arm64.dmg",
  "https://github.com/example-owner/morrow-downloads/releases/download/v1.0.0/Morrow-1.0.0-win-x64.exe",
  "https://github.com/example-owner/morrow-downloads/releases/download/v1.0.0/Morrow-1.0.0-source.zip",
  "https://github.com/example-owner/morrow-downloads/releases/download/v1.0.0/SHA256SUMS",
  "https://support.apple.com/en-us/102445",
  "https://support.microsoft.com/en-us/office/protect-my-pc-from-viruses",
];

const MAC_DOWNLOAD_URL = "https://github.com/example-owner/morrow-downloads/releases/download/v1.0.0/Morrow-1.0.0-mac-arm64.dmg";
const WINDOWS_DOWNLOAD_URL = "https://github.com/example-owner/morrow-downloads/releases/download/v1.0.0/Morrow-1.0.0-win-x64.exe";

const SITE_ORIGIN = "https://meetmorrow.app";

// Every route the site publishes. `/` is index.html; `/<name>` is `<name>.html`.
const PUBLIC_ROUTES = [
  "/",
  "/features",
  "/how-it-works",
  "/remote",
  "/for-instructors",
  "/for-instructional-designers",
  "/for-lms-admins",
  "/for-curriculum-developers",
  "/for-qa-teams",
  "/for-teams",
  "/download",
  "/build",
  "/support",
  "/privacy",
  "/terms",
  "/security",
];

// The error page is served but is not a public route, so it carries no current-page state and is
// not required in the footer.
const ERROR_ROUTE = "/404";

// HTML in `website/` that is not a served page. `social-card.html` is the 1200x630 source rendered
// locally to produce `social-card.png`; it has no shell and uses relative asset URLs on purpose.
const BUILD_SOURCE_FILES = ["social-card.html"];

const SERVED_ROUTES = [...PUBLIC_ROUTES, ERROR_ROUTE];
const SHARED_ASSETS = ["/styles.css", "/roles.css", "/script.js"];

const fileForRoute = (route) => (route === "/" ? "index.html" : `${route.slice(1)}.html`);

function loadPages() {
  return SERVED_ROUTES.map((route) => {
    const file = fileForRoute(route);
    const url = new URL(file, site);
    return { route, file, html: existsSync(url) ? readFileSync(url, "utf8") : null };
  });
}

const pages = present ? loadPages() : [];
const readablePages = pages.filter((page) => page.html !== null);
const htmlFiles = present ? readdirSync(site).filter((name) => name.endsWith(".html")).sort() : [];

function attributes(source) {
  const parsed = {};
  for (const match of source.matchAll(/([a-zA-Z][a-zA-Z0-9:_-]*)="([^"]*)"/g)) parsed[match[1]] = match[2];
  return parsed;
}

const tagsNamed = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, "g"))].map((match) => attributes(match[1]));
const metaContent = (html, key, value) => tagsNamed(html, "meta").find((tag) => tag[key] === value)?.content ?? null;
const idsIn = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
const referencesIn = (html) => [...html.matchAll(/(?:href|src)="([^"]*)"/g)].map((match) => match[1]);
const isAssetPath = (path) => /\.[a-z0-9]+$/i.test(path);

function region(html, tag) {
  const found = [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "g"))];
  return found.length === 1 ? found[0][0] : null;
}

test("website/ holds exactly the pages this contract covers", { skip }, () => {
  const expected = [...SERVED_ROUTES.map(fileForRoute), ...BUILD_SOURCE_FILES].sort();
  assert.deepEqual(
    htmlFiles,
    expected,
    "a page was added or removed; update PUBLIC_ROUTES or BUILD_SOURCE_FILES so the new file is covered",
  );
});

test("every internal link resolves to a page, an anchor, or a file that exists", { skip }, () => {
  const knownIds = new Map(readablePages.map((page) => [page.route, idsIn(page.html)]));
  const broken = [];

  for (const page of readablePages) {
    for (const reference of referencesIn(page.html)) {
      if (reference.startsWith("#")) {
        const fragment = reference.slice(1);
        if (fragment && !knownIds.get(page.route).has(fragment)) broken.push(`${page.file} -> ${reference} (no such id on this page)`);
        continue;
      }
      if (!reference.startsWith("/")) continue;

      const [target, fragment] = reference.split("#");
      const path = target.split("?")[0];

      if (isAssetPath(path)) {
        if (!existsSync(new URL(path.slice(1), site))) broken.push(`${page.file} -> ${reference} (no such file in website/)`);
        continue;
      }
      if (!SERVED_ROUTES.includes(path)) {
        broken.push(`${page.file} -> ${reference} (not a served route)`);
        continue;
      }
      if (!knownIds.has(path)) {
        broken.push(`${page.file} -> ${reference} (${fileForRoute(path)} is missing)`);
        continue;
      }
      if (fragment && !knownIds.get(path).has(fragment)) broken.push(`${page.file} -> ${reference} (no id "${fragment}" on ${fileForRoute(path)})`);
    }
  }

  assert.deepEqual(broken, [], "these links point at something that does not exist");
});

test("no page links a site asset with a relative path", { skip }, () => {
  const relative = [];
  for (const page of readablePages) {
    for (const reference of referencesIn(page.html)) {
      if (reference.startsWith("/") || reference.startsWith("#")) continue;
      if (/^(?:https?:|mailto:|tel:|data:)/i.test(reference)) continue;
      relative.push(`${page.file} -> ${reference}`);
    }
  }
  assert.deepEqual(relative, [], "site assets must use a root-absolute path so the route works with or without a trailing slash");
});

test("every page has one h1 and no heading-level jump", { skip }, () => {
  const problems = [];
  for (const page of readablePages) {
    const levels = [...page.html.matchAll(/<h([1-6])\b/g)].map((match) => Number(match[1]));
    const firstLevel = levels.filter((level) => level === 1).length;
    if (firstLevel !== 1) problems.push(`${page.file} has ${firstLevel} h1 elements`);
    for (let index = 1; index < levels.length; index += 1) {
      if (levels[index] > levels[index - 1] + 1) problems.push(`${page.file} jumps from h${levels[index - 1]} to h${levels[index]}`);
    }
  }
  assert.deepEqual(problems, [], "each page needs one h1 and heading levels that step down by one");
});

test("every page carries its own canonical, description, and share tags", { skip }, () => {
  const problems = [];
  const descriptions = new Map();

  for (const page of readablePages) {
    const own = `${SITE_ORIGIN}${page.route}`;
    const canonical = tagsNamed(page.html, "link").find((tag) => tag.rel === "canonical")?.href ?? null;
    if (canonical !== own) problems.push(`${page.file} canonical is ${canonical ?? "missing"}, expected ${own}`);

    const description = metaContent(page.html, "name", "description");
    if (!description) problems.push(`${page.file} has no meta description`);
    else if (descriptions.has(description)) problems.push(`${page.file} repeats the meta description of ${descriptions.get(description)}`);
    else descriptions.set(description, page.file);

    for (const property of ["og:title", "og:description", "og:image"]) {
      if (!metaContent(page.html, "property", property)) problems.push(`${page.file} has no ${property}`);
    }
    const openGraphUrl = metaContent(page.html, "property", "og:url");
    if (openGraphUrl !== own) problems.push(`${page.file} og:url is ${openGraphUrl ?? "missing"}, expected ${own}`);
    if (!metaContent(page.html, "name", "twitter:card")) problems.push(`${page.file} has no twitter:card`);
  }

  assert.deepEqual(problems, [], "a shared page without these tags renders as a bare URL");
});

test("every public page marks its own route as the current page", { skip }, () => {
  const problems = [];
  for (const page of readablePages) {
    const current = tagsNamed(page.html, "a").filter((tag) => tag["aria-current"] === "page");
    if (page.route === ERROR_ROUTE) {
      if (current.length !== 0) problems.push(`${page.file} marks a current page, but /404 is not a route`);
      continue;
    }
    if (current.length !== 1) {
      problems.push(`${page.file} has ${current.length} links with aria-current="page", expected 1`);
      continue;
    }
    if (current[0].href !== page.route) problems.push(`${page.file} marks ${current[0].href} as the current page, expected ${page.route}`);
  }
  assert.deepEqual(problems, [], "the current-page state must name the page the reader is on");
});

test("every page footer links every public route", { skip }, () => {
  const problems = [];
  for (const page of readablePages) {
    const footer = region(page.html, "footer");
    if (!footer) {
      problems.push(`${page.file} does not have exactly one footer`);
      continue;
    }
    const linked = new Set(referencesIn(footer));
    const missing = PUBLIC_ROUTES.filter((route) => !linked.has(route));
    if (missing.length > 0) problems.push(`${page.file} footer omits ${missing.join(", ")}`);
  }
  assert.deepEqual(problems, [], "the footer is the only route list on pages that hide the nav menu");
});

test("the shared stylesheet and script use one cache token across the site", { skip }, () => {
  const problems = [];
  for (const asset of SHARED_ASSETS) {
    const tokens = new Map();
    for (const page of readablePages) {
      for (const reference of referencesIn(page.html)) {
        const [path, query] = reference.split("?");
        if (path !== asset) continue;
        if (!query) problems.push(`${page.file} requests ${asset} with no cache token`);
        else if (!tokens.has(query)) tokens.set(query, [page.file]);
        else tokens.get(query).push(page.file);
      }
    }
    if (tokens.size > 1) {
      const listed = [...tokens.entries()].map(([query, files]) => `?${query} on ${files.join(", ")}`);
      problems.push(`${asset} is requested with ${tokens.size} different cache tokens: ${listed.join(" / ")}`);
    }
  }
  assert.deepEqual(problems, [], "two cache tokens for identical bytes make readers download the file twice");
});

test("no page uses a banned phrase", { skip }, () => {
  const found = [];
  for (const file of htmlFiles) {
    const html = readFileSync(new URL(file, site), "utf8");
    for (const phrase of BANNED_PHRASES) {
      if (html.toLowerCase().includes(phrase.toLowerCase())) found.push(`${file}: "${phrase}"`);
    }
  }
  assert.deepEqual(found, [], "these phrases contradict how Morrow is described to the people who use it");
});

test("every absolute link is the site's own origin or an allowlisted external destination", { skip }, () => {
  const problems = [];
  for (const file of htmlFiles) {
    const html = readFileSync(new URL(file, site), "utf8");
    for (const reference of referencesIn(html)) {
      if (!/^https?:/i.test(reference)) continue;
      if (reference.startsWith(`${SITE_ORIGIN}/`)) {
        const path = new URL(reference).pathname;
        const known = SERVED_ROUTES.includes(path) || (isAssetPath(path) && existsSync(new URL(path.slice(1), site)));
        if (!known) problems.push(`${file} -> ${reference} (not a served route or an existing file)`);
        continue;
      }
      if (!EXTERNAL_LINK_ALLOWLIST.includes(reference)) problems.push(`${file} -> ${reference} (add it to EXTERNAL_LINK_ALLOWLIST once it is checked)`);
    }
  }
  assert.deepEqual(problems, [], "an unlisted external link can go dead without anything noticing");
});

test("every external destination used by the website answers", {
  skip: skip || (process.env.MORROW_CHECK_EXTERNAL_LINKS === "1" ? false : "set MORROW_CHECK_EXTERNAL_LINKS=1 to check external links over the network"),
}, async () => {
  const problems = [];
  const used = new Set(htmlFiles.flatMap((file) => referencesIn(readFileSync(new URL(file, site), "utf8"))));
  for (const url of EXTERNAL_LINK_ALLOWLIST.filter((value) => used.has(value))) {
    try {
      let response = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(15_000) });
      if (response.status === 405 || response.status === 501) {
        response = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(15_000) });
      }
      if (response.status >= 400) problems.push(`${url} answered HTTP ${response.status}`);
    } catch (cause) {
      problems.push(`${url} could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  assert.deepEqual(problems, [], "an allowlisted link must resolve; remove it or fix it");
});

const STYLESHEETS = ["styles.css", "roles.css"];

/**
 * Class selectors the stylesheets keep for a section that is not built yet. It is empty, which is
 * the state it should spend almost all of its life in: a rule no element matches is a rule the next
 * reader will edit by mistake. It held six names for one wave, while the shared stylesheets were
 * rewritten ahead of the pages that use them, and was emptied again as soon as the last page landed.
 * Add an entry only for a section that is genuinely planned, and take it off when that section lands
 * or when the plan for it is dropped. Classes that `website/script.js` creates at runtime are found
 * from the script itself and are not listed here.
 */
export const CSS_CLASSES_RESERVED_FOR_UNBUILT_SECTIONS = [];

// Strip comments, url() arguments, and quoted strings, then keep only the selector half of each
// rule, so a file name such as Manrope-variable.ttf is never read as a class selector.
function classSelectorsIn(css) {
  const cleaned = css
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/url\([^)]*\)/g, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/'[^']*'/g, " ");
  const names = new Set();
  for (const rule of cleaned.matchAll(/([^{}]+)\{/g)) {
    for (const match of rule[1].matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) names.add(match[1]);
  }
  return names;
}

test("every class selector in the stylesheets matches an element on a page", { skip }, () => {
  const inMarkup = new Set();
  for (const file of htmlFiles) {
    for (const attribute of readFileSync(new URL(file, site), "utf8").matchAll(/class="([^"]*)"/g)) {
      for (const name of attribute[1].split(/\s+/)) if (name) inMarkup.add(name);
    }
  }

  const script = readFileSync(new URL("script.js", site), "utf8");
  const atRuntime = new Set([
    ...[...script.matchAll(/classList\.(?:add|remove|toggle)\(\s*["']([^"']+)["']/g)].map((m) => m[1]),
    ...[...script.matchAll(/className\s*=\s*["']([^"']+)["']/g)].flatMap((m) => m[1].split(/\s+/)),
  ]);

  const unmatched = [];
  for (const file of STYLESHEETS) {
    for (const name of classSelectorsIn(readFileSync(new URL(file, site), "utf8"))) {
      if (inMarkup.has(name) || atRuntime.has(name)) continue;
      if (CSS_CLASSES_RESERVED_FOR_UNBUILT_SECTIONS.includes(name)) continue;
      unmatched.push(`${file}: .${name}`);
    }
  }

  assert.deepEqual(unmatched.sort(), [], "a rule no element matches is a rule the next reader will edit by mistake");
});

test("the reserved class list holds nothing a page already uses", { skip }, () => {
  const inMarkup = new Set();
  for (const file of htmlFiles) {
    for (const attribute of readFileSync(new URL(file, site), "utf8").matchAll(/class="([^"]*)"/g)) {
      for (const name of attribute[1].split(/\s+/)) if (name) inMarkup.add(name);
    }
  }
  const built = CSS_CLASSES_RESERVED_FOR_UNBUILT_SECTIONS.filter((name) => inMarkup.has(name));
  assert.deepEqual(built, [], "these sections now exist; take their classes off the reserved list");
});

const relativeLuminance = (hex) => {
  const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export function contrastRatio(foreground, background) {
  const [high, low] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}

const declaredValue = (block, property) => block.match(new RegExp(`${property}\\s*:\\s*([^;}]+)`))?.[1].trim() ?? null;

// WCAG 2.2 SC 1.4.11 and 2.4.11: a focus indicator needs 3:1 against what it sits on. The navy band
// sections keep their own dark background in both themes, so the ring on them is checked twice.
test("the focus ring clears 3:1 on every navy band section, in both themes", { skip }, () => {
  const withoutComments = (file) => readFileSync(new URL(file, site), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const styles = withoutComments("styles.css");
  const roles = withoutComments("roles.css");

  const lightRoot = styles.match(/:root\s*\{([^}]*)\}/)[1];
  const darkRoot = styles.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/)[1];
  const bands = { light: declaredValue(lightRoot, "--band"), dark: declaredValue(darkRoot, "--band") };
  assert.match(bands.light, /^#[0-9a-f]{6}$/i, "--band must be a hex colour so this check can compute a ratio");
  assert.match(bands.dark, /^#[0-9a-f]{6}$/i, "the dark --band must be a hex colour");

  const selectorsOf = (rule) => rule.split(",").map((part) => part.trim().replace(/\s+/g, " ")).filter(Boolean);
  const onBand = [];
  const ringFor = new Map();
  for (const css of [styles, roles]) {
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const [, selector, body] = rule;
      if (selector.trim().startsWith("@")) continue;
      if (/background:\s*var\(--band\)/.test(body)) onBand.push(...selectorsOf(selector));
      const ring = declaredValue(body, "--focus-ring");
      if (ring) for (const one of selectorsOf(selector)) ringFor.set(one, ring);
    }
  }
  assert.ok(onBand.length > 0, "no section uses the band background; this check would prove nothing");

  const problems = [];
  for (const selector of onBand) {
    const ring = ringFor.get(selector);
    if (!ring) {
      problems.push(`${selector} sits on --band but sets no --focus-ring`);
      continue;
    }
    if (!/^#[0-9a-f]{6}$/i.test(ring)) {
      problems.push(`${selector} sets --focus-ring: ${ring}; this check needs a hex colour`);
      continue;
    }
    for (const [theme, band] of Object.entries(bands)) {
      const ratio = contrastRatio(ring, band);
      if (ratio < 3) problems.push(`${selector} focus ring ${ring} is ${ratio.toFixed(2)}:1 on the ${theme} band ${band}`);
    }
  }
  assert.deepEqual(problems, [], "a focus ring below 3:1 leaves keyboard users unable to see where they are");
});

// The MORROW-WEBSITE-BRIEF.md route table for `/` requires a "remote section, product media and
// download path", and the brief requires the illustrative conversations to be labelled once. The
// four checks below hold those sections on the homepage.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// JPEG frame headers. Every SOFn except the four marker values reused for other segments carries
// the image size in the same place.
const JPEG_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/**
 * The pixel size a capture file carries in its own header, so a declared width/height is checked
 * against the file rather than against itself. Reads PNG and JPEG, which is what `website/assets/`
 * holds; anything else returns null and the caller reports that it could not be measured.
 */
function imageSize(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE) && bytes.toString("ascii", 12, 16) === "IHDR") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    if (marker === 0xff) { at += 1; continue; }             // fill byte before the next marker
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { at += 2; continue; }
    const length = bytes.readUInt16BE(at + 2);
    if (length < 2) return null;
    if (JPEG_FRAME_MARKERS.has(marker)) {
      if (at + 9 > bytes.length) return null;
      return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
    }
    if (marker === 0xda) return null;                       // scan data starts; no frame header found
    at += 2 + length;
  }
  return null;
}

const visibleText = (html) => html
  .replace(/<[^>]*>/g, " ")
  .replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/\s+/g, " ")
  .trim();

const homePage = () => readFileSync(new URL("index.html", site), "utf8");

/** The one `<section>` whose heading the given id names. New homepage sections carry no nested
 *  section, so the first closing tag after the attribute is this section's own. */
function sectionLabelledBy(html, id) {
  const at = html.indexOf(`aria-labelledby="${id}"`);
  if (at === -1) return null;
  const open = html.lastIndexOf("<section", at);
  const close = html.indexOf("</section>", at);
  if (open === -1 || close === -1) return null;
  return html.slice(open, close + "</section>".length);
}

test("the homepage remote section names both remote products, the host requirement, and the approval boundary", { skip }, () => {
  const section = sectionLabelledBy(homePage(), "home-remote-title");
  assert.ok(section, 'the homepage needs a remote section labelled by "home-remote-title"');
  const text = visibleText(section);

  const missing = [
    "ChatGPT Remote",
    "Claude Code Remote Control",
    "awake",
    "online",
    "signed in",
    "Morrow Bridge",
  ].filter((required) => !text.includes(required));
  assert.deepEqual(missing, [], "the remote section must name both products and the state the host computer has to keep");

  assert.match(text, /permission prompt is not Morrow approval/, "the section must state that an assistant's own prompt is not Morrow approval");
  assert.ok(referencesIn(section).includes("/remote"), "the remote section must link /remote");
});

test("the homepage product media shows real captures with a caption and its own pixel size", { skip }, () => {
  const html = homePage();
  const figures = [...html.matchAll(/<figure\b[\s\S]*?<\/figure>/g)].map((match) => match[0]);
  assert.ok(figures.length > 0, "the homepage needs at least one captioned product capture");

  const problems = [];
  for (const figure of figures) {
    const image = tagsNamed(figure, "img")[0];
    if (!image) {
      problems.push("a figure holds no image");
      continue;
    }
    if (!image.src?.startsWith("/assets/")) {
      problems.push(`${image.src} is not a capture in website/assets/`);
      continue;
    }
    const file = new URL(image.src.slice(1), site);
    if (!existsSync(file)) {
      problems.push(`${image.src} is not a file in website/assets/`);
      continue;
    }
    const size = imageSize(readFileSync(file));
    if (!size) problems.push(`${image.src} is not a PNG or JPEG this check can measure`);
    else if (Number(image.width) !== size.width || Number(image.height) !== size.height) {
      problems.push(`${image.src} declares ${image.width}x${image.height}, the file is ${size.width}x${size.height}`);
    }
    if (!image.alt || image.alt.trim().length < 20) problems.push(`${image.src} needs alt text that describes the capture`);

    const caption = figure.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/);
    const captionText = caption ? visibleText(caption[1]) : "";
    if (captionText.length < 40) problems.push(`${image.src} needs a caption saying what the reader learns from it`);
    // docs/brand/MORROW-BRAND.md, "Claims and screenshots": a capture must not imply that Morrow
    // made the state it shows, so every caption states what it does not prove.
    else if (!/does not (show|prove)/.test(captionText)) problems.push(`${image.src} caption does not say what the capture is not evidence of`);
  }

  assert.deepEqual(problems, [], "a product capture must be a real file, sized, described, and captioned within its evidence");
});

test("the homepage guides a reader to choose a computer and continue setup", { skip }, () => {
  const html = homePage();
  const section = sectionLabelledBy(html, "home-download-title");
  assert.ok(section, 'the homepage needs a download section labelled by "home-download-title"');
  const copy = visibleText(section);
  for (const required of ["Mac", "Windows", "Morrow Bridge"]) assert.ok(copy.includes(required), `the setup path must name ${required}`);
  assert.doesNotMatch(copy, /unsigned|pending|release status|no installer/i, "the homepage must not turn setup into release-status copy");
  assert.ok(referencesIn(section).includes("/download"), "the download section must link /download");
});

test("the public claims keep the platform, permission, and review boundaries", { skip }, () => {
  const source = (file) => readFileSync(new URL(file, site), "utf8");
  const features = source("features.html");
  const build = source("build.html");
  const privacy = source("privacy.html");

  assert.match(features, /Canvas and Moodle connect through Morrow Bridge in the Chrome window/, "Canvas and Moodle must use the signed-in Chrome route");
  assert.match(features, /Blackboard uses a connection your administrator sets up/, "Blackboard must use the administrator connection");
  assert.match(build, /Proposed course changes wait for your review/, "a reader must keep the final decision");
  assert.doesNotMatch(privacy, /removes? (?:the )?student names|replaces each person/i, "the privacy page must not promise automatic anonymization");
  assert.match(privacy, /do not rely on Morrow to make sensitive content anonymous/, "the privacy limit must be clear");
});

test("the site does not explain that its example course data is fictional", { skip }, () => {
  const prohibited = /\b(?:fictional|mock|demo|simulated|sample|test) (?:course )?data\b|\b(?:example conversation|these examples)\b/i;
  const problems = [];
  for (const file of htmlFiles) {
    const text = visibleText(pageSource(file));
    if (prohibited.test(text)) problems.push(file);
  }
  assert.deepEqual(problems, [], "the website must show the examples without an unnecessary data disclaimer");
});

test("content uses surfaces and spacing instead of horizontal divider language", { skip }, () => {
  const problems = [];
  for (const file of htmlFiles) {
    if (/<hr\b/i.test(pageSource(file))) problems.push(`${file}: contains an hr element`);
  }

  for (const file of STYLESHEETS) {
    const lines = pageSource(file).split("\n");
    lines.forEach((line, index) => {
      if (!/border-(?:top|bottom|block)(?:-[a-z]+)?\s*:/.test(line)) return;
      if (/\.nav-menu-button i::after|\.menu-toggle i|\.scenario-picker::after/.test(line)) return;
      problems.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }

  assert.deepEqual(problems, [], "sections, lists, and cards must not rebuild the removed horizontal-rule system");
});

test("headings wrap at the type scale and conversation transcripts stay available", { skip }, () => {
  const styles = pageSource("styles.css");
  const script = pageSource("script.js");
  assert.match(styles, /h2, h3, h4 \{[^}]*white-space: normal;[^}]*text-wrap: balance;/);
  assert.doesNotMatch(script, /fitTitles|createRange\(|conversation-stage\.js/);
  assert.doesNotMatch(styles, /\.conversation-bubble\.is-revealing|@keyframes scenario-enter/);
});

test("navigation disclosures do not claim menu semantics they do not implement", { skip }, () => {
  const problems = htmlFiles.filter((file) => /aria-haspopup=/.test(pageSource(file)));
  assert.deepEqual(problems, []);
});

test("support starts with setup, separates connection and course help, and keeps uncertain changes safe", { skip }, () => {
  const html = pageSource("support.html");
  const ids = ["support-start", "connection-help", "course-help", "support-contact"];
  const positions = ids.map((id) => html.indexOf(`id="${id}"`));
  assert.ok(positions.every((position) => position >= 0), "support must include all four help routes");
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right), "support routes must follow the order a reader needs");
  assert.ok(referencesIn(html).includes("/download"));
  assert.doesNotMatch(visibleText(html), /Not set up yet/i);
  assert.match(visibleText(html), /Do not send the same change again\.[\s\S]*check the earlier change/);
  assert.match(visibleText(html), /Do not send student records, passwords, sign-in details, or screenshots that show student information/);
  assert.ok(referencesIn(html).includes("mailto:hello@meetmorrow.app"));
});

test("privacy value is prominent and stays inside the proven learner-report boundary", { skip }, () => {
  for (const file of ["index.html", "features.html", "how-it-works.html", "download.html", "privacy.html"]) {
    const html = pageSource(file);
    assert.match(html, /data-privacy-value/, `${file} needs a visible privacy-value block`);
    assert.ok(referencesIn(html).includes("/privacy") || file === "privacy.html", `${file} must link to the full privacy policy`);
  }

  const combined = ["index.html", "features.html", "how-it-works.html", "download.html"].map(pageSource).join("\n");
  assert.match(combined, /sign-in stays in Chrome/);
  assert.match(combined, /known roster identities/);
  assert.match(combined, /exact course and complete roster/);
  assert.match(combined, /Course text can still contain personal information/);
  assert.doesNotMatch(combined, /automatic(?:ally)? (?:remove|filter|redact)|all (?:student|learner) (?:names|information)|fully anonymous/i);

  const privacy = pageSource("privacy.html");
  assert.match(privacy, /This is not general anonymization/);
  assert.match(privacy, /do not rely on Morrow to make sensitive content anonymous/);
});

test("the footer presents the full site in three readable groups", { skip }, () => {
  const problems = [];
  for (const page of readablePages) {
    const footer = region(page.html, "footer");
    if (!footer) continue;
    const groups = [...footer.matchAll(/class="footer-group"/g)].length;
    for (const label of ["Product", "For educators", "Help and trust"]) {
      if (!visibleText(footer).includes(label)) problems.push(`${page.file}: missing ${label}`);
    }
    if (groups !== 3) problems.push(`${page.file}: ${groups} footer groups`);
  }
  assert.deepEqual(problems, []);
  assert.match(pageSource("styles.css"), /\.site-footer a \{[^}]*min-height: 44px/);
});

test("team reports do not promise a shared or cross-computer Morrow workspace", { skip }, () => {
  const teams = visibleText(pageSource("for-teams.html"));
  assert.match(teams, /Morrow does not provide a shared team workspace/);
  assert.doesNotMatch(teams, /open (?:the set|a handoff|the handoff) through Morrow on (?:her|his|their) own computer/i);
  assert.match(teams, /share through your institution’s approved system/);
});

test("role-page setup actions describe what their links do", { skip }, () => {
  const problems = [];
  for (const file of ILLUSTRATED_PAGES.filter((name) => name !== "features.html")) {
    const text = visibleText(pageSource(file));
    if (text.includes("Copy your first request")) problems.push(file);
  }
  assert.deepEqual(problems, []);
});

// The product pages carry the claims a reader checks before installing: what a course audit can
// detect, which platforms Morrow reaches, and what adding Morrow Bridge takes today. Each check
// below reads the page together with the source its claim comes from, so a change to either side
// fails here.
const PRODUCT_PAGES = ["features.html", "how-it-works.html", "download.html", "build.html"];

/**
 * Detection claims these pages must not carry. `packages/mcp-server/src/course-audit.ts` returns
 * saved-source signals for links with no text, URL text, and generic text; none of them establishes
 * that a link is unclear, and the only repair helpers are for image alternative text and one Page
 * phrase. A page may say the assistant judges link wording; it may not say Morrow detects it. Add a
 * page to PRODUCT_PAGES as the same claim is corrected there.
 */
export const LINK_DETECTION_CLAIMS = ["unclear link", "link text", "vague link"];

/**
 * docs/implementation/MORROW-1.0-COMPLETION-GOAL.md permits a temporary Developer mode install of
 * Morrow Bridge with "No commands or path typing", so a setup page must never route the reader to a
 * command line or an address to type.
 */
const SETUP_COMMAND_PATTERNS = [/chrome:\/\//i, /command line/i, /\bterminal\b/i, /\bsudo\b/i, /\bnpm \b/i, /\bpnpm \b/i];

const productPage = (file) => readFileSync(new URL(file, site), "utf8");

test("no product page claims Morrow detects unclear link wording", { skip }, () => {
  const found = [];
  for (const file of PRODUCT_PAGES) {
    const text = productPage(file).toLowerCase();
    for (const claim of LINK_DETECTION_CLAIMS) if (text.includes(claim)) found.push(`${file}: "${claim}"`);
  }
  assert.deepEqual(found, [], "Morrow reports link signals for review; it does not detect or repair unclear link wording");
});

test("/how-it-works gives the exact Bridge actions and /download keeps setup in the app", { skip }, () => {
  const problems = [];
  const setup = visibleText(productPage("how-it-works.html"));
  for (const required of ["Show Bridge folder", "Developer mode", "Load unpacked"]) {
    if (!setup.includes(required)) problems.push(`how-it-works.html does not name ${required}`);
  }
  const download = productPage("download.html");
  if (!/guided screen[\s\S]*adding Morrow Bridge/.test(download)) problems.push("download.html must leave the detailed Bridge actions in the app");
  if (!download.includes('/how-it-works#steps-title')) problems.push("download.html must link the full setup explanation");
  if (/until Morrow Bridge has|temporary step/i.test(`${setup} ${visibleText(download)}`)) problems.push("setup contains internal release-status copy");
  assert.deepEqual(problems, [], "the install route a person follows today has to be on the pages that describe setup");
});

test("/download gives each computer its exact v1.0.0 release link and plain install steps", { skip }, () => {
  const html = productPage("download.html");
  const links = tagsNamed(html, "a");

  for (const [url, description] of [
    [MAC_DOWNLOAD_URL, "mac-download-title"],
    [WINDOWS_DOWNLOAD_URL, "windows-download-title"],
  ]) {
    const link = links.find((candidate) => candidate.href === url);
    assert.ok(link, `/download must link to ${url}`);
    assert.equal(link["aria-describedby"], description, `${url} must describe its matching build`);
  }

  for (const [titleId, build, steps] of [
    ["mac-download-title", "Mac", [
      "Open the Morrow download.",
      "Drag Morrow into Applications.",
      "Open Morrow from Applications to start setup.",
    ]],
    ["windows-download-title", "Windows", [
      "Open the Morrow download.",
      "Morrow installs for your account and opens automatically.",
      "If needed, open Morrow from the Start menu to start setup.",
    ]],
  ]) {
    const labelled = html.indexOf(`aria-labelledby="${titleId}"`);
    assert.ok(labelled >= 0, `${build} must have its own download card`);
    const close = html.indexOf("</article>", labelled);
    const copy = html.slice(labelled, close).replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
    const positions = steps.map((step) => copy.indexOf(step));
    assert.ok(positions.every((position) => position >= 0), `${build} must state each native install step`);
    assert.deepEqual(positions, [...positions].sort((left, right) => left - right), `${build} must state the steps in order`);
  }
});

test("the release download copy uses no em dash and keeps the direct homepage headline exact", { skip }, () => {
  for (const file of ["download.html", "how-it-works.html", "styles.css"]) {
    assert.doesNotMatch(readFileSync(new URL(file, site), "utf8"), /\u2014/, `${file} must not contain an em dash`);
  }
  assert.match(
    homePage(),
    /<h1 id="hero-title">Morrow connects your own ChatGPT and Claude to the courses you manage\.<\/h1>/,
    "the homepage headline is approved copy and must remain exact",
  );
  assert.match(
    homePage(),
    /<p class="hero-note">Morrow is and always will be free and open source\.<\/p>/,
    "the homepage must state the permanent free and open source promise word for word",
  );
  assert.doesNotMatch(
    homePage(),
    /Morrow starts in Plan, where each proposed change waits for you before it is saved\./,
    "the removed Plan sentence must not return to the homepage hero",
  );
  assert.match(
    pageSource("styles.css"),
    /\.hero h1 \{ font-size: clamp\(2rem, 8\.5vw, 2\.25rem\); \}/,
    "the mobile homepage title must keep its balanced smaller size",
  );
  assert.match(
    pageSource("styles.css"),
    /h1 \{ max-width: none !important; white-space: normal; text-wrap: balance; \}/,
    "page titles must wrap at a readable size instead of shrinking to one line",
  );
});

test("no product page tells the reader to type an address or run a command", { skip }, () => {
  const found = [];
  for (const file of PRODUCT_PAGES) {
    const text = visibleText(productPage(file));
    for (const pattern of SETUP_COMMAND_PATTERNS) {
      const match = text.match(pattern);
      if (match) found.push(`${file}: "${match[0]}"`);
    }
  }
  assert.deepEqual(found, [], "setup is visual; a command or a typed address is not a step a reader is given");
});

test("the product pages explain the three platform connection paths", { skip }, () => {
  const problems = [];
  for (const file of ["features.html", "download.html", "how-it-works.html"]) {
    const copy = visibleText(productPage(file));
    for (const required of ["Canvas", "Moodle", "Blackboard"]) if (!copy.includes(required)) problems.push(`${file} does not name ${required}`);
  }
  assert.deepEqual(problems, [], "a reader needs to know that Canvas and Moodle use Chrome while Blackboard needs the institution connection");
});

const PUBLIC_COPY_PATTERNS = [
  /\baccess token\b/i,
  /\bdeveloper key\b/i,
  /\bAPI credentials?\b/i,
  /\binstitution-issued\b/i,
  /\bcourse data\b/i,
  /\bAI assistant\b/i,
  /\bApple silicon\b/i,
  /\b(?:Windows )?x64\b/i,
  /\b64-bit\b/i,
  /\bChrome \d+\b/i,
  /\.dmg\b/i,
  /\.exe\b/i,
  /\bSHA-256\b/i,
  /\bunsigned\b/i,
  /\baccessibility pass\b/i,
  /\bassistive-technology\b/i,
  /\bthe gateway\b/i,
];

test("public copy uses educator language instead of setup and product jargon", { skip }, () => {
  const found = [];
  for (const file of htmlFiles) {
    const text = visibleText(pageSource(file));
    for (const pattern of PUBLIC_COPY_PATTERNS) {
      const match = text.match(pattern);
      if (match) found.push(`${file}: "${match[0]}"`);
    }
  }
  assert.deepEqual(found, [], "write what an instructor sees and does, and keep file and system terms out of the public copy");
});

test("the GitHub header control and free and open source promise stay visible", { skip }, () => {
  const problems = [];
  for (const page of readablePages) {
    const header = region(page.html, "header");
    const footer = region(page.html, "footer");
    const github = header ? tagsNamed(header, "a").filter((tag) => tag.class === "github-link") : [];
    if (github.length !== 1) problems.push(`${page.file}: expected one GitHub header control, found ${github.length}`);
    else {
      if (github[0].href !== "https://github.com/example-owner/morrow-downloads") problems.push(`${page.file}: GitHub header target`);
      if (github[0].target !== "_blank" || github[0].rel !== "noopener noreferrer") problems.push(`${page.file}: GitHub header safety`);
      if (!visibleText(header).includes("View on GitHub")) problems.push(`${page.file}: GitHub header label`);
    }
    if (!footer || !visibleText(footer).includes("Free and open source")) problems.push(`${page.file}: footer`);
  }
  assert.deepEqual(problems, [], "keep the established GitHub header control and the plain footer source link on every page");
  assert.ok(visibleText(pageSource("build.html")).includes("Morrow is and always will be free and open source."));

  const heroCopy = pageSource("index.html").match(/<div class="hero-copy">([\s\S]*?)<ul class="hero-proof">/)?.[1] ?? "";
  assert.match(
    heroCopy,
    /^\s*<p>Ask for real course work in ChatGPT, Claude, or Gemini\.[\s\S]*?<\/p>\s*<p class="hero-note">Morrow is and always will be free and open source\.<\/p>\s*$/,
    "the homepage promise must follow the hero subtext and precede the proof list",
  );

  const valueItems = [...pageSource("index.html").matchAll(/<ul class="hero-proof">([\s\S]*?)<\/ul>/g)]
    .flatMap((match) => [...match[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map((item) => visibleText(item[1])));
  assert.deepEqual(valueItems, [
    "Turn a syllabus, readings, and faculty notes into organized lessons, activities, and assessments.",
    "Review an existing course for accessibility problems, missing instructions, inconsistent dates, and differences between sections.",
    "See the exact pages, assignments, quizzes, discussions, or dates before your assistant uses Morrow to save any change.",
    "After an approved change, see what changed, what stayed untouched, and what still needs you.",
  ], "the homepage hero must lead with four concrete course-work results");
});

test("each marketing page starts with the correct Morrow and assistant relationship", { skip }, () => {
  const expected = new Map([
    ["features.html", "Morrow helps your assistant build, review, and improve the courses you manage."],
    ["for-curriculum-developers.html", "Morrow helps your assistant trace one learning outcome across your program."],
    ["for-instructional-designers.html", "Morrow helps your assistant build one course and improve fourteen more."],
    ["for-instructors.html", "Morrow lets your assistant check all your course sections in one request."],
    ["for-lms-admins.html", "Morrow lets your assistant compare every course section in one request."],
    ["for-qa-teams.html", "Morrow helps your assistant find repeated course problems and fix the cause."],
    ["for-teams.html", "Morrow helps your team coordinate work across a program."],
    ["how-it-works.html", "Download Morrow. The app walks you through the rest."],
    ["remote.html", "Keep using Morrow with your assistant from your phone."],
  ]);

  const actual = new Map([...expected.keys()].map((file) => {
    const heading = pageSource(file).match(/<h1(?:\s[^>]*)?>([\s\S]*?)<\/h1>/)?.[1] ?? "";
    return [file, visibleText(heading)];
  }));
  assert.deepEqual(actual, expected);
});



// --- The copy the whole site shares --------------------------------------------------------------
// Six checks over every page at once. Each one holds a correction that was made on seventeen files
// in one wave, and each names, in its comment, the defect it stops from coming back a page at a
// time.

const pageSource = (file) => readFileSync(new URL(file, site), "utf8");

/** The `<main>` region: where a page makes its claims. The header and footer are route lists. */
function mainRegion(html) {
  const open = html.indexOf("<main");
  if (open === -1) return html;
  const close = html.indexOf("</main>", open);
  return close === -1 ? html.slice(open) : html.slice(open, close + "</main>".length);
}

/** The label every assistant turn carries, in the casing Braden wrote it in. */
const ASSISTANT_LABEL = "Your Assistant using Morrow";

test("every reply in every conversation is labelled 'Your Assistant using Morrow'", { skip }, () => {
  // The bubbles used to be labelled "Morrow", which told the reader that Morrow is the thing they
  // talk to. It is not: they talk to the assistant they already use, and Morrow is what gives that
  // assistant their courses. A reply labelled "Morrow" turns the whole site into an advertisement
  // for a second chat window, which is the one thing Morrow is not.
  const problems = [];
  let replies = 0;
  for (const file of htmlFiles) {
    const html = pageSource(file);
    for (const wrong of ["<span>Morrow</span>", "<strong>Morrow</strong>"]) {
      if (html.includes(wrong)) problems.push(`${file} still labels a speaker ${wrong}`);
    }
    for (const opening of html.matchAll(/<[a-z]+\b[^>]*class="[^"]*(?:conversation-response|role-message-response)[^"]*"[^>]*>/g)) {
      replies += 1;
      const after = html.slice(opening.index + opening[0].length, opening.index + opening[0].length + 120);
      if (!new RegExp(`^<(span|strong)>${ASSISTANT_LABEL}</\\1>`).test(after)) {
        problems.push(`${file}: a reply opens "${after.slice(0, 48)}…" instead of the assistant label`);
      }
    }
  }
  assert.ok(replies > 40, `only ${replies} replies were found; this check would prove nothing`);
  assert.deepEqual(problems, [], "the reader talks to their own assistant, so every reply says which assistant is speaking and what it is using");
});

test("every illustrated conversation uses the role that would do the work", { skip }, () => {
  const expected = {
    "index.html": [
      ...Array(3).fill("Instructor"),
      ...Array(3).fill("Instructional designer"),
      ...Array(3).fill("Instructor"),
      ...Array(3).fill("LMS administrator"),
      ...Array(3).fill("Curriculum developer, on phone"),
    ],
    "features.html": Array(3).fill("Instructor"),
    "for-instructors.html": Array(6).fill("Instructor"),
    "for-instructional-designers.html": Array(6).fill("Instructional designer"),
    "for-lms-admins.html": Array(6).fill("LMS administrator"),
    "for-curriculum-developers.html": Array(6).fill("Curriculum developer"),
    "for-qa-teams.html": Array(6).fill("QA lead"),
    "for-teams.html": Array(3).fill("Instructional designer"),
    "remote.html": [...Array(3).fill("Instructor, on phone"), ...Array(3).fill("QA lead, on phone")],
  };
  const problems = [];
  for (const [file, wanted] of Object.entries(expected)) {
    const html = pageSource(file);
    const actual = [];
    for (const match of html.matchAll(/<[a-z]+\b[^>]*class="[^"]*(?:conversation-request|role-message-request)[^"]*"[^>]*>\s*<(span|strong)>([^<]+)<\/\1>/g)) {
      actual.push(match[2]);
    }
    if (actual.length !== wanted.length || actual.some((speaker, index) => speaker !== wanted[index])) {
      problems.push(`${file}: ${JSON.stringify(actual)}`);
    }
  }
  assert.deepEqual(problems, [], "a course example must sound like the educator named above it");
});

test("promotional conversations show completed work instead of false capability gaps", { skip }, () => {
  const problems = [];
  let messages = 0;
  const gapLanguage = /\b(?:could not|unable|unavailable|unsupported|not supported|human review|manual review|needs? (?:a |the )?person|requires? (?:a |the )?person|anything it cannot)\b|\b(?:Morrow|I|we|you) (?:cannot|can’t|can't)\b/i;

  for (const file of ["index.html", ...ILLUSTRATED_PAGES]) {
    const html = pageSource(file);
    for (const match of html.matchAll(/<(div|p)\b[^>]*class="[^"]*(?:conversation-bubble|role-message)[^"]*"[^>]*>([\s\S]*?)<\/\1>/g)) {
      messages += 1;
      const text = visibleText(match[2]);
      if (gapLanguage.test(text)) problems.push(`${file}: "${text}"`);
    }
    for (const [index, section] of conversationSections(html).entries()) {
      const text = visibleText(section);
      if (gapLanguage.test(text)) problems.push(`${file} conversation ${index + 1}: "${text}"`);
    }
    for (const [index, match] of [...html.matchAll(/<article\b[^>]*class="[^"]*conversation-panel[^"]*"[^>]*>([\s\S]*?)<\/article>/g)].entries()) {
      const text = visibleText(match[1]);
      if (gapLanguage.test(text)) problems.push(`${file} scenario ${index + 1}: "${text}"`);
    }
  }

  assert.ok(messages >= 120, `only ${messages} sample messages were checked`);
  assert.deepEqual(problems, [], "a product example must show what Morrow and the assistant accomplish, not advertise a false hole in their capability");
});

test("course work belongs to the assistant and Morrow stays the tool it uses", { skip }, () => {
  const problems = [];
  const misassignedWork = /\bMorrow (?:builds|reviews|checks|checked|reads|read|drafts|groups|compares|traces|prepares|creates|created|made|applies|applied)\b/i;

  for (const file of PUBLIC_ROUTES.map(fileForRoute)) {
    const main = visibleText(mainRegion(pageSource(file)));
    const match = main.match(misassignedWork);
    if (match) problems.push(`${file}: assigns course work to the tool with "${match[0]}"`);
  }

  for (const file of ["index.html", ...ILLUSTRATED_PAGES]) {
    for (const match of pageSource(file).matchAll(/<(div|p)\b[^>]*class="[^"]*(?:conversation-bubble|role-message)[^"]*"[^>]*>([\s\S]*?)<\/\1>/g)) {
      const text = visibleText(match[2]);
      if (misassignedWork.test(text)) problems.push(`${file}: assistant says "${text}"`);
    }
  }

  assert.match(
    visibleText(mainRegion(pageSource("index.html"))),
    /Your assistant can use Morrow to build lessons[\s\S]*Morrow supplies the course tools; your assistant does the work/,
  );
  assert.deepEqual(problems, [], "the assistant performs course work; Morrow supplies the course tools it uses");
});

test("the homepage accessibility request covers course files, videos, Item Banks, and New Quizzes", { skip }, () => {
  const html = pageSource("index.html");
  const start = html.indexOf('id="scenario-panel-accessibility"');
  const end = html.indexOf("</article>", start);
  assert.ok(start !== -1 && end !== -1, "the homepage accessibility conversation is missing");
  const panel = html.slice(start, end);

  assert.match(panel, /<span>Instructor<\/span><p>[^<]*pages, files, videos, Item Banks, and New Quizzes/);
  for (const phrase of [
    "18 course files",
    "nine videos",
    "two Item Banks",
    "four New Quizzes",
    "videos without captions",
    "accessible replacements for three PDFs",
    "opened every item through Morrow and checked it again",
  ]) assert.ok(panel.includes(phrase), `the homepage accessibility conversation must include "${phrase}"`);
});

/**
 * The controls the app asks a person to use, in the order it asks for them. Every
 * name in this list is a control the app or Chrome actually shows, so a reader can follow the page
 * with the screen in front of them. The order matters as much as the names: the setup page was
 * describing an install route that had not been current for months, and a step named out of order
 * is the same defect as a step left out.
 */
const SETUP_STEP_NAMES = [
  "Show Bridge folder",
  "Manage Extensions",
  "Developer mode",
  "Load unpacked",
  "Connect Morrow",
  "Allow connection",
  "Connect Canvas",
  "Connect Moodle",
  "Plan",
];

test("/how-it-works names every setup control, in the order the app asks for it", { skip }, () => {
  const text = visibleText(pageSource("how-it-works.html"));
  const problems = [];
  let from = 0;
  for (const step of SETUP_STEP_NAMES) {
    const at = text.indexOf(step, from);
    if (at === -1) {
      problems.push(text.includes(step) ? `${step} appears before the step above it` : `${step} is not named at all`);
      continue;
    }
    from = at + step.length;
  }
  assert.deepEqual(problems, [], "a reader follows these steps with the app open; a missing or reordered control leaves them stuck");
});

test("/how-it-works presents three stages and keeps the materials folder optional", { skip }, () => {
  const section = sectionLabelledBy(pageSource("how-it-works.html"), "steps-title");
  assert.ok(section, "the setup section is missing");
  const list = section;
  assert.equal((list.match(/<li><div class="workflow-word">/g) || []).length, 3, "setup must present exactly three high-level stages");
  assert.match(list, /Download and open Morrow[\s\S]*Follow the setup in the app[\s\S]*Open your course and let Morrow Bridge identify it/);
  assert.doesNotMatch(list, /<h3>[^<]*(?:materials|folder)/i, "the optional materials folder must not become a setup stage");
});

test("the main setup action goes straight to the download", { skip }, () => {
  const problems = [];
  for (const file of htmlFiles) {
    if (file === "social-card.html") continue;
    const html = pageSource(file);
    const control = html.match(/<a class="nav-download" href="([^"]+)">([^<]+)<\/a>/);
    if (!control) {
      problems.push(`${file}: missing main download action`);
      continue;
    }
    if (control[1] !== "/download" || control[2].trim() !== "Download") {
      problems.push(`${file}: ${control[2].trim()} -> ${control[1]}`);
    }
  }
  assert.deepEqual(problems, [], "the site must give one direct setup action instead of routing through another explanation page");
  assert.doesNotMatch(visibleText(pageSource("features.html")), /six setup steps/i);
  assert.match(pageSource("features.html"), /class="button button-primary" href="\/download">Download Morrow/);
  assert.match(pageSource("support.html"), /class="button button-primary" href="\/download">Download Morrow/);
});

/**
 * The four assistants the installer sets up (installer/shared/contract.cjs:10-15, README.md:317).
 * Naming one of them, or writing "a supported assistant", loses the reader who uses another: the
 * whole argument is that Morrow works with the assistant they already have.
 */
const ASSISTANT_NAMES = ["ChatGPT", "Claude Desktop", "Claude Code", "Gemini CLI"];

/** The pages a reader decides on. Each has to answer "does this work with mine?" on its own. */
const PAGES_NAMING_EVERY_ASSISTANT = ["index.html", "features.html", "how-it-works.html", "download.html"];

test("every page a reader decides on names all four assistants", { skip }, () => {
  const problems = [];
  for (const file of PAGES_NAMING_EVERY_ASSISTANT) {
    const text = visibleText(pageSource(file));
    const missing = ASSISTANT_NAMES.filter((name) => !text.includes(name));
    if (missing.length > 0) problems.push(`${file} does not name ${missing.join(", ")}`);
  }
  assert.deepEqual(problems, [], "a reader who uses one of the four has to see it named before they decide Morrow is not for them");
});

/**
 * Words this site printed at people who do not work on it. Every one is Morrow's own vocabulary, a
 * word from its source, or an architecture term, and each has a plain replacement:
 *
 *   saved source, saved-source     -> the text Canvas saved
 *   course item                    -> page, assignment, discussion, quiz - name the kind
 *   Plan mode                      -> Plan, explained the first time a page uses it
 *   assistant session              -> the assistant running on your computer
 *   opaque reference               -> a stand-in label
 *   " target " (the noun)          -> the page, the assignment, the item on your list
 *   the ledger                     -> the records Morrow saved on your computer
 *   pass rate                      -> say what was checked and what was not
 *   tenant                         -> your Blackboard site
 *   catalog                        -> the work Morrow can do
 *   fixture                        -> a local copy of a Moodle page
 *   runtime, dispatch, readback    -> say what happens: it runs, it sends, it reads the item back
 *   digest                         -> the summary
 *   MCP                            -> nothing; the reader never needs the protocol's name
 *
 * The canonical platform sentence is exempt, and only because LIMITATIONS.md requires it word for
 * word; see the check that pins it to one occurrence on each page allowed to quote it.
 */
export const RETIRED_JARGON = [
  "saved source",
  "saved-source",
  "course item",
  "Plan mode",
  "assistant session",
  "opaque reference",
  " target ",
  "the ledger",
  "pass rate",
  "tenant",
  "catalog",
  "fixture",
  "runtime",
  "dispatch",
  "readback",
  "digest",
  "MCP",
];

test("no page prints Morrow's own vocabulary at the reader", { skip }, () => {
  const found = [];
  for (const file of htmlFiles) {
    const text = visibleText(pageSource(file)).toLowerCase();
    for (const phrase of RETIRED_JARGON) {
      if (text.includes(phrase.toLowerCase())) found.push(`${file}: "${phrase.trim()}"`);
    }
  }
  assert.deepEqual(found, [], "an instructor reading this page has never seen the inside of Morrow; write what they would say");
});

test("the retired 'Installer in progress' status is on no page", { skip }, () => {
  // It was the site's answer to "can I have it?" on three pages at once, and it told a reader
  // nothing they could act on. /download now states what each build is and what has been run.
  const found = htmlFiles.filter((file) => pageSource(file).includes("Installer in progress"));
  assert.deepEqual(found, [], "say which build exists, what it is, and what has been checked on it");
});

/** A sentence that tells the reader which platforms Morrow reaches, as opposed to one that names a
 *  platform while describing something else ("the Canvas or Moodle courses you can open"). */
const PLATFORM_COVERAGE_CLAIM = /\b(?:works? with|supports?|supported|compatible with|coverage|available (?:in|for))\b/i;

const PLATFORMS = ["Canvas", "Moodle", "Blackboard"];

test("the product pages name Canvas, Moodle, and Blackboard", { skip }, () => {
  const problems = [];
  for (const file of PRODUCT_PAGES) {
    const copy = visibleText(mainRegion(pageSource(file)));
    const missing = PLATFORMS.filter((platform) => !copy.includes(platform));
    if (missing.length > 0) problems.push(`${file} does not name ${missing.join(", ")}`);
  }
  assert.deepEqual(problems, [], "each product page must distinguish the Chrome path from the Blackboard institution connection");
});

// The role pages and /remote carry the illustrative conversations, the counted examples, and the
// per-role depth MORROW-WEBSITE-BRIEF.md requires ("Braden rejected the first role pages as too
// thin… The role pages must have distinct content"). The checks below hold that shape, and bind the
// two claims these pages make about Morrow's own behaviour to the source those claims come from.

const ROLE_PAGES = [
  "for-instructors.html",
  "for-instructional-designers.html",
  "for-lms-admins.html",
  "for-curriculum-developers.html",
  "for-qa-teams.html",
];

const ILLUSTRATED_PAGES = [...ROLE_PAGES, "remote.html", "for-teams.html", "features.html"];

/**
 * Sentences the role pages are allowed to repeat word for word. Nothing else may be shared; add an
 * entry only for text whose value comes from being identical.
 */
export const SHARED_ROLE_SENTENCES = [
  // The speaker label on every assistant turn. A reader should meet the same label on every page,
  // so varying it would be the defect rather than the repetition. It is 27 characters, which is
  // longer than the run this check ignores, so without this entry every role page reads as sharing
  // a paragraph with every other one.
  "Your Assistant using Morrow",
];

/** The section on each role page that states the visitor's inputs and what comes back. */
const ROLE_INPUT_SECTIONS = {
  "for-instructors.html": "instructor-materials",
  "for-instructional-designers.html": "designer-materials",
  "for-lms-admins.html": "admin-materials",
  "for-curriculum-developers.html": "curriculum-materials",
  "for-qa-teams.html": "qa-ledger",
};

const rolePage = (file) => readFileSync(new URL(file, site), "utf8");

/** Conversation sections hold no nested `<section>`, so the first closing tag is their own. */
function conversationSections(html) {
  const found = [];
  for (const match of html.matchAll(/<section class="role-conversation-section[^"]*"[^>]*>/g)) {
    const close = html.indexOf("</section>", match.index);
    const section = html.slice(match.index, close + "</section>".length);
    assert.equal(section.indexOf("<section", 1), -1, "a conversation section must not nest another section");
    found.push(section);
  }
  return found;
}

/** A top-level section, kept whole even when it nests the two-column task groups. Every section in
 *  these pages opens on its own line at six spaces of indent, which ends the slice. */
function topLevelSection(html, id) {
  const at = html.indexOf(`aria-labelledby="${id}"`);
  if (at === -1) return null;
  const open = html.lastIndexOf("<section", at);
  const next = html.indexOf("\n      <section", at);
  return html.slice(open, next === -1 ? html.length : next);
}



test("no role page and no /remote claims Morrow detects unclear link wording", { skip }, () => {
  const found = [];
  for (const file of ILLUSTRATED_PAGES) {
    const text = rolePage(file).toLowerCase();
    for (const claim of LINK_DETECTION_CLAIMS) if (text.includes(claim)) found.push(`${file}: "${claim}"`);
  }
  assert.deepEqual(found, [], "Morrow reports link signals for review; it does not detect or repair unclear link wording");
});

test("the link labels /for-instructional-designers quotes are the ones the audit reports", { skip }, () => {
  const source = new URL("../../packages/mcp-server/src/course-audit.ts", import.meta.url);
  assert.ok(existsSync(source), "course-audit.ts holds the saved-source signals the site describes");
  const declared = readFileSync(source, "utf8").match(/GENERIC_LINK_TEXT = new Set\(\[([^\]]*)\]\)/);
  assert.ok(declared, "GENERIC_LINK_TEXT is the list of link labels the audit reports");
  const detected = [...declared[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();

  const quoted = rolePage("for-instructional-designers.html").match(/links labelled only ([^.]*)\./);
  assert.ok(quoted, "/for-instructional-designers states which link labels Morrow reports");
  const onPage = [...quoted[1].matchAll(/“([^”]+)”/g)].map((match) => match[1]).sort();

  assert.deepEqual(onPage, detected, "the page names a closed list, so it has to match the set the audit actually reports");
});

/**
 * The heading /for-qa-teams gives each state `PROGRAM_LEDGER_FINAL_STATES` defines. The headings
 * used to be the state names themselves, spelled out as "Evidence ready pending review", which told
 * a reader nothing, so the page says what each one means to them instead and the mapping is
 * declared here. Every state must have an entry and every entry must be a heading on the page, so a
 * state added to the ledger still fails this check exactly as it did before.
 */
export const QA_REVIEW_STATE_HEADINGS = {
  repaired_and_verified: "Fixed and checked",
  manually_checked: "You checked it yourself",
  not_applicable_with_evidence: "Nothing to check here",
  evidence_ready_pending_review: "Ready for you to read",
  unread: "Not read",
  blocked: "Stopped",
  held: "Waiting on a person",
};

test("the /for-qa-teams page joins broad Morrow checks with definitive learner-view review", { skip }, () => {
  const page = rolePage("for-qa-teams.html");
  assert.match(page, /Your assistant uses Morrow to check pages, files, videos, Item Banks, and New Quizzes/);
  assert.match(page, /Certification also uses learner-view tests, assistive technology, and expert judgment/);
  assert.match(page, /automated findings, approved repairs, learner-view checks, and expert decisions/);
});

test("every role page carries its own one-sentence description and its own share-card alt", { skip }, () => {
  const problems = [];
  const descriptions = new Map();
  const alts = new Map();

  for (const file of ROLE_PAGES) {
    const html = rolePage(file);
    const description = metaContent(html, "name", "description");
    if (!description) {
      problems.push(`${file} has no meta description`);
    } else {
      if ((description.match(/\.(?:\s|$)/g) ?? []).length !== 1) problems.push(`${file} description is not one sentence: "${description}"`);
      if (descriptions.has(description)) problems.push(`${file} repeats the description of ${descriptions.get(description)}`);
      else descriptions.set(description, file);
      for (const [key, name] of [["property", "og:description"], ["name", "twitter:description"]]) {
        if (metaContent(html, key, name) !== description) problems.push(`${file} ${name} does not repeat its own description`);
      }
    }

    const alt = metaContent(html, "property", "og:image:alt");
    if (!alt) problems.push(`${file} has no og:image:alt`);
    else {
      if (alts.has(alt)) problems.push(`${file} repeats the share-card alt of ${alts.get(alt)}`);
      else alts.set(alt, file);
      if (metaContent(html, "name", "twitter:image:alt") !== alt) problems.push(`${file} twitter:image:alt does not match its og:image:alt`);
    }
  }

  assert.deepEqual(problems, [], "a shared role page has to describe itself, not the homepage");
});

test("no two role pages share a paragraph word for word", { skip }, () => {
  // Compared as text runs between tags rather than as whole elements: a paragraph nested inside a
  // list item is its own run, so pasting one item's copy into another page is caught.
  const runs = new Map();
  for (const file of ROLE_PAGES) {
    const html = rolePage(file);
    // Up to the related-links band: that band is a route list like the footer, so its link labels
    // are the same on every page by design.
    const main = html.slice(html.indexOf("<main"), html.indexOf('<section class="role-related"'));
    for (const match of main.matchAll(/>([^<>]+)</g)) {
      let text = visibleText(match[1]);
      for (const shared of SHARED_ROLE_SENTENCES) text = text.split(shared).join(" ").replace(/\s+/g, " ").trim();
      if (text.length <= 25) continue;
      if (!runs.has(text)) runs.set(text, new Set());
      runs.get(text).add(file);
    }
  }
  const shared = [...runs].filter(([, files]) => files.size > 1).map(([text, files]) => `${[...files].join(" + ")}: "${text.slice(0, 80)}…"`);
  assert.deepEqual(shared, [], "a paragraph on two role pages is a template substitution, not content for that role");
});

test("every role page states what the visitor brings and what comes back", { skip }, () => {
  const problems = [];
  const headings = new Map();
  for (const [file, id] of Object.entries(ROLE_INPUT_SECTIONS)) {
    const section = topLevelSection(rolePage(file), id);
    if (!section) {
      problems.push(`${file} has no section labelled by "${id}"`);
      continue;
    }
    const groups = [...section.matchAll(/<h3>([^<]+)<\/h3>/g)].map((match) => match[1]);
    if (groups.length !== 2) problems.push(`${file} "${id}" has ${groups.length} groups, expected the inputs and the outputs`);
    const items = [...section.matchAll(/<h4>([^<]+)<\/h4>/g)].length;
    if (items < 5) problems.push(`${file} "${id}" names ${items} items; a role visitor needs more than that`);
    for (const group of groups) {
      if (headings.has(group)) problems.push(`${file} reuses the group heading "${group}" from ${headings.get(group)}`);
      else headings.set(group, file);
    }
  }
  assert.deepEqual(problems, [], "the brief requires the materials the person can bring, and the inputs and outputs, on every role page");
});

test("every role page ends with one copyable first request bound to that role", { skip }, () => {
  const problems = [];
  const requests = new Map();
  for (const file of ROLE_PAGES) {
    const html = rolePage(file);
    const sections = conversationSections(html).filter((section) => /aria-labelledby="[a-z-]+-first-request"/.test(section));
    if (sections.length !== 1) {
      problems.push(`${file} has ${sections.length} first-request sections, expected 1`);
      continue;
    }
    const [section] = sections;
    if (section.includes("role-message-response")) problems.push(`${file}: the first request is a template to send, not a transcript`);

    const messages = [...section.matchAll(/<p class="role-message role-message-request">([\s\S]*?)<\/p>/g)];
    if (messages.length !== 1) {
      problems.push(`${file} offers ${messages.length} requests to copy, expected 1`);
      continue;
    }
    const text = visibleText(messages[0][1]);
    if (!/\[[^\]]+\]/.test(text)) problems.push(`${file}: the request needs a bracketed placeholder the reader replaces`);
    if (text.length < 160) problems.push(`${file}: the request is too short to be the reader's first complete instruction`);
    if (requests.has(text)) problems.push(`${file} offers the same request as ${requests.get(text)}`);
    else requests.set(text, file);

    const at = html.indexOf(section);
    if (at < html.indexOf('class="role-faq')) problems.push(`${file}: the first request must follow the questions, not precede them`);
    const after = html.slice(at + section.length);
    if (/<section class="role-(?!related)/.test(after)) problems.push(`${file}: the first request must be the last content section`);
  }
  assert.deepEqual(problems, [], "each role page ends in a request the reader can send after setup");
});

test("the final website pass keeps role examples, broad media coverage, setup copy, headings, and the tablet capture intentional", { skip }, () => {
  const designer = topLevelSection(rolePage("for-instructional-designers.html"), "designer-workflow-two");
  const qa = topLevelSection(rolePage("for-qa-teams.html"), "qa-workflow-one");
  assert.ok(designer, "the instructional-designer design brief is missing");
  assert.ok(qa, "the QA review conversation is missing");
  assert.match(designer, /Turn a course pattern into a design brief/);
  assert.match(designer, /Nothing has changed in a course/);
  assert.doesNotMatch(designer, /104 things to check|Eight templates account|46 repairs across/);
  assert.match(qa, /I used Morrow to check 684 pages, files, videos, bank questions, and quiz questions/);
  assert.match(qa, /62 changes across 41 pages, files, videos, Item Bank questions, and New Quiz items/);

  for (const [file, phrase] of [
    ["features.html", "Your assistant uses Morrow to check image descriptions, heading order, table headers, document structure, and whether videos include captions."],
    ["for-instructional-designers.html", "Your assistant uses Morrow to find missing image descriptions, heading and table problems, document structure problems, and videos without captions."],
    ["for-qa-teams.html", "17 PDFs without document headings, nine videos without captions"],
    ["index.html", "Go through the pages, files, videos, Item Banks, and New Quizzes."],
  ]) assert.ok(pageSource(file).includes(phrase), `${file} must show the full accessibility and media review capability`);

  for (const file of ["index.html", "how-it-works.html"]) {
    const headings = [...pageSource(file).matchAll(/<h3(?:\s[^>]*)?>([\s\S]*?)<\/h3>/g)].map((match) => visibleText(match[1]));
    assert.ok(headings.length > 0, `${file} has no h3 headings to check`);
    assert.ok(headings.every((heading) => heading.endsWith(".")), `${file} mixes h3 heading punctuation`);
  }

  const download = pageSource("download.html");
  const setup = pageSource("how-it-works.html");
  assert.ok(!download.includes("Adding Morrow Bridge takes one manual step"), "/download keeps the retired long setup lead");
  assert.ok(!setup.includes("Morrow lists the assistants it found"), "/how-it-works keeps the retired long setup copy");
  assert.match(download, /Morrow Bridge connects Morrow on your computer to the signed-in Canvas or Moodle tab/);
  assert.match(setup, /Morrow finds the assistants on your computer/);

  const styles = readFileSync(new URL("styles.css", site), "utf8");
  assert.match(styles, /@media \(max-width: 920px\) \{[\s\S]*?\.course-capture \{ display: none; \}/);
  assert.doesNotMatch(styles, /@media \(max-width: 600px\) \{[\s\S]*?\.course-capture img/);
});

// --- Payload, caching, and the files that describe them ------------------------------------------

const assetsDirectory = new URL("assets/", site);
const assetFiles = present ? readdirSync(assetsDirectory).sort() : [];
const brandDocument = new URL("../../docs/brand/MORROW-BRAND.md", import.meta.url);

/**
 * Files in `website/assets/` that ship without a page or stylesheet reference. The SIL Open Font
 * License requires the license text to travel with the font, so `Manrope-OFL.txt` is published even
 * though nothing links it. Nothing else belongs here: an unreferenced file is bytes every reader
 * pays for and no reader receives.
 */
export const ASSETS_SHIPPED_WITHOUT_A_REFERENCE = ["Manrope-OFL.txt"];

// Every file in website/ that can name an asset: the pages, the stylesheets, and the scripts.
const sourceFiles = () => readdirSync(site).filter((name) => /\.(?:html|css|js)$/.test(name));
const assetNamesIn = (text) => [...text.matchAll(/assets\/([A-Za-z0-9._-]+)/g)].map((match) => match[1]);

test("every file in website/assets/ is used by a page or a stylesheet", { skip }, () => {
  const used = new Map();
  for (const file of sourceFiles()) {
    for (const name of assetNamesIn(readFileSync(new URL(file, site), "utf8"))) {
      if (!used.has(name)) used.set(name, file);
    }
  }

  const missing = [...used.keys()].filter((name) => !assetFiles.includes(name)).sort();
  assert.deepEqual(missing, [], "a page or stylesheet names an asset that is not in website/assets/");

  const unused = assetFiles
    .filter((name) => !used.has(name) && !ASSETS_SHIPPED_WITHOUT_A_REFERENCE.includes(name))
    .sort();
  assert.deepEqual(unused, [], "these files are published and reach no reader; delete them or use them");

  const unneeded = ASSETS_SHIPPED_WITHOUT_A_REFERENCE.filter((name) => !assetFiles.includes(name));
  assert.deepEqual(unneeded, [], "this exemption names a file that is no longer in website/assets/");
});

/**
 * Parse a Cloudflare Pages `_headers` file. An unindented line opens a rule and names the path
 * pattern; the indented lines under it either set a header or, when they start with `! `, detach
 * one. Entries keep their file order so a test can ask whether the detach comes before the set.
 */
function headerRules(text) {
  const rules = [];
  for (const line of text.split("\n")) {
    const body = line.trim();
    if (!body || body.startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      rules.push({ path: body, entries: [] });
      continue;
    }
    if (body.startsWith("! ")) {
      rules.at(-1).entries.push({ detach: body.slice(2).trim() });
      continue;
    }
    const at = body.indexOf(":");
    rules.at(-1).entries.push({ name: body.slice(0, at).trim(), value: body.slice(at + 1).trim() });
  }
  return rules;
}

const headerValue = (rule, name) => rule.entries.find((entry) => entry.name === name)?.value ?? null;
const detaches = (rule, name) => rule.entries.some((entry) => entry.detach === name);

// Cloudflare Pages applies every matching rule and joins two values for one header name with a
// comma, so a second Cache-Control would produce two max-age directives in one header.
const REQUIRED_ON_EVERY_RESPONSE = [
  "Content-Security-Policy",
  "Referrer-Policy",
  "X-Content-Type-Options",
  "Permissions-Policy",
  "X-Frame-Options",
];

test("_headers caches assets for a year and keeps every page revalidating", { skip }, () => {
  const text = readFileSync(new URL("_headers", site), "utf8");
  const rules = headerRules(text);

  assert.deepEqual(rules.map((rule) => rule.path), ["/*", "/assets/*"], "the broad rule must come first, then the asset rule");

  const [everything, assets] = rules;
  assert.equal(
    headerValue(everything, "Cache-Control"),
    "public, max-age=0, must-revalidate, no-transform",
    "HTML must revalidate; no-transform is what stopped a script being injected into a live page",
  );
  for (const name of REQUIRED_ON_EVERY_RESPONSE) {
    assert.ok(headerValue(everything, name), `/* must still set ${name}`);
  }

  const assetCache = headerValue(assets, "Cache-Control");
  assert.ok(assetCache, "/assets/* must set Cache-Control");
  for (const directive of ["public", "max-age=31536000", "immutable", "no-transform"]) {
    assert.ok(assetCache.split(", ").includes(directive), `/assets/* Cache-Control is missing ${directive}`);
  }

  // Two rules match every asset request. Without the detach the two Cache-Control values are joined
  // with a comma and the response carries max-age=0 and max-age=31536000 at once.
  const joined = [];
  for (const rule of rules.slice(1)) {
    for (const entry of rule.entries) {
      if (!entry.name || headerValue(everything, entry.name) === null) continue;
      const detachAt = rule.entries.findIndex((other) => other.detach === entry.name);
      const setAt = rule.entries.indexOf(entry);
      if (detachAt === -1 || detachAt > setAt) joined.push(`${rule.path}: ${entry.name}`);
    }
  }
  assert.deepEqual(joined, [], "a header /* already sets must be detached above the line that sets it again");
  assert.ok(detaches(assets, "Cache-Control"), "/assets/* must detach the /* Cache-Control before setting its own");

  // Cloudflare Pages limits: 100 rules, 2,000 characters a line.
  assert.ok(rules.length <= 100, `${rules.length} rules exceeds the 100 Cloudflare Pages allows`);
  const tooLong = text.split("\n").filter((line) => line.length > 2000);
  assert.deepEqual(tooLong, [], "a _headers line may hold at most 2,000 characters");

  for (const rule of rules) {
    const names = rule.entries.filter((entry) => entry.name).map((entry) => entry.name);
    assert.deepEqual([...new Set(names)], names, `${rule.path} sets one header twice, which joins the two values`);
  }
});

test("sitemap.xml lists exactly the public routes", { skip }, () => {
  const text = readFileSync(new URL("sitemap.xml", site), "utf8");
  assert.match(text, /^<\?xml version="1\.0" encoding="UTF-8"\?>/, "a sitemap needs its XML declaration");
  assert.match(text, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/, "the urlset needs the sitemap namespace");

  const listed = [...text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.deepEqual(
    listed,
    PUBLIC_ROUTES.map((route) => `${SITE_ORIGIN}${route}`),
    "the sitemap lists every public route once, and nothing that is not a public route",
  );
});

// Parse robots.txt into [directive, value] pairs, lowercasing the directive name so the file may be
// written the conventional way.
function robotsDirectives(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf(":");
      return [line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()];
    });
}

test("robots.txt allows crawling and points at the sitemap", { skip }, () => {
  const directives = robotsDirectives(readFileSync(new URL("robots.txt", site), "utf8"));
  const values = (name) => directives.filter(([key]) => key === name).map(([, value]) => value);

  assert.deepEqual(values("user-agent"), ["*"], "one group, addressed to every crawler");
  assert.ok(values("allow").includes("/"), "the site must state that it allows crawling");
  assert.deepEqual(values("sitemap"), [`${SITE_ORIGIN}/sitemap.xml`], "robots.txt must name the sitemap once, absolutely");

  const blocked = values("disallow").filter(Boolean);
  assert.ok(!blocked.includes("/"), "Disallow: / would hide the whole site");
  const wrong = blocked.filter((path) => PUBLIC_ROUTES.includes(path) || path === "/social-card.png");
  assert.deepEqual(wrong, [], "a public route stays crawlable, and the share card must load for link previews");
  const absent = blocked.filter((path) => !existsSync(new URL(path.slice(1), site)));
  assert.deepEqual(absent, [], "robots.txt blocks a path that does not exist");
});

// Files the Assets section may name that live outside website/assets/.
const ASSET_SECTION_MAY_NAME = ["styles.css", "social-card.html"];

test("website/README.md describes the files website/assets/ actually holds", { skip }, () => {
  const readme = readFileSync(new URL("README.md", site), "utf8");
  const section = readme.slice(readme.indexOf("## Assets")).split("\n## ")[0];
  assert.ok(section.startsWith("## Assets"), "README.md needs an Assets section");

  const named = [...section.matchAll(/`([A-Za-z0-9._-]+\.[a-z0-9]+)`/g)].map((match) => match[1]);
  const strangers = [...new Set(named)]
    .filter((name) => !assetFiles.includes(name) && !ASSET_SECTION_MAY_NAME.includes(name))
    .sort();
  assert.deepEqual(strangers, [], "the Assets section names a file that is not in website/assets/");

  const undescribed = assetFiles.filter((name) => !named.includes(name));
  assert.deepEqual(undescribed, [], "these files ship without the README saying what they are");
});

const sha256 = (url) => createHash("sha256").update(readFileSync(url)).digest("hex");

test("the shipped fonts are the files the brand document and the README record", { skip }, () => {
  const ttf = sha256(new URL("assets/Manrope-variable.ttf", site));
  const woff2 = sha256(new URL("assets/Manrope-variable.woff2", site));

  const brand = readFileSync(brandDocument, "utf8");
  assert.ok(
    [...brand.matchAll(/`([0-9a-f]{64})`/g)].some((match) => match[1] === ttf),
    "docs/brand/MORROW-BRAND.md records a SHA-256 for the unmodified variable font; the shipped TTF must be that file",
  );

  const readme = readFileSync(new URL("README.md", site), "utf8");
  const recorded = new Map(
    [...readme.matchAll(/`(Manrope-variable\.(?:ttf|woff2))`[^`]*`([0-9a-f]{64})`/g)].map((match) => [match[1], match[2]]),
  );
  assert.equal(recorded.get("Manrope-variable.ttf"), ttf, "website/README.md records a stale TTF hash");
  assert.equal(recorded.get("Manrope-variable.woff2"), woff2, "website/README.md records a stale WOFF2 hash");

  // The WOFF2 is the format every current browser takes. Shipping it larger than the TTF would mean
  // the conversion did not happen.
  assert.ok(
    statSync(new URL("assets/Manrope-variable.woff2", site)).size < statSync(new URL("assets/Manrope-variable.ttf", site)).size,
    "the WOFF2 must be smaller than the TrueType file it replaces on the wire",
  );
});

test("every _redirects rule sends the reader to a public route without shadowing one", { skip }, () => {
  const rules = readFileSync(new URL("_redirects", site), "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/));

  const problems = [];
  for (const [from, to, status] of rules) {
    if (!PUBLIC_ROUTES.includes(to)) problems.push(`${from} -> ${to} is not a public route`);
    if (SERVED_ROUTES.includes(from)) problems.push(`${from} shadows a page the site serves`);
    // The deployment excludes the internal website README.
    if (from !== "/README.md" && existsSync(new URL(from.slice(1), site))) problems.push(`${from} shadows a file in website/`);
    if (!["301", "302"].includes(status)) problems.push(`${from} uses status ${status}; use 301 or 302`);
  }
  assert.deepEqual(problems, [], "an old URL must land on a page that exists");
});
