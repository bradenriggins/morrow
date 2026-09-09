#!/usr/bin/env node

/**
 * Renders every served page in `website/` at every tested width and fails on any horizontal
 * overflow the page can show a visitor.
 *
 * A layout defect is any of these, at any width:
 *
 * 1. the document scrolls sideways (`documentElement.scrollWidth` exceeds the viewport);
 * 2. any element's content exceeds its own box (`scrollWidth` exceeds `clientWidth`), whether the
 *    overflow is clipped (`overflow-x: hidden`) or hangs out in plain sight (`overflow-x: visible`);
 * 3. any element's right edge extends past the right edge of the box that contains it.
 *
 * Conditions 2 and 3 exist because of a real defect that condition 1 alone passed: at 390px the two
 * index hero buttons did not fit their two-column grid, the secondary button's nowrap content was
 * 180px inside a 173px box and the row was 364px inside 358px, its arrow sliced at the screen edge.
 * `overflow-x` was `visible`, so nothing clipped and the document did not scroll, and every earlier
 * check was blind to it.
 *
 * Elements that are scroll containers by design (`overflow-x: auto` or `scroll`) are exempt from
 * condition 2 only: they are meant to scroll their own content. Visually hidden elements (the
 * 1px-clipped `.github-link span` pattern) are exempt because hiding their content is the design.
 *
 * Usage: node scripts/website-render-check.mjs [--root <dir>] [--widths 320,390,...] [--json <file>]
 * Exits non-zero and prints every violation when a page overflows.
 */

import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";

export const RENDER_WIDTHS = Object.freeze([320, 390, 400, 414, 480, 600, 768, 1024, 1440]);

// HTML in `website/` that is not a served page, mirroring scripts/test/website-content.test.mjs.
const BUILD_SOURCE_FILES = Object.freeze(["social-card.html"]);

const CONTENT_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
});

/** The served routes of a website root: every HTML file that is not a build source, as clean URLs. */
export async function servedRoutes(root) {
  const files = (await readdir(root)).filter((name) => name.endsWith(".html") && !BUILD_SOURCE_FILES.includes(name)).sort();
  return files.map((file) => ({ route: file === "index.html" ? "/" : `/${file.slice(0, -".html".length)}`, file }));
}

function startStaticServer(root) {
  const server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const candidates = pathname === "/" ? ["index.html"] : [pathname.slice(1), `${pathname.slice(1)}.html`];
    const relative = candidates.find((candidate) => existsSync(join(root, candidate)));
    if (!relative) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    const body = await readFile(join(root, relative));
    response.writeHead(200, { "content-type": CONTENT_TYPES[extname(relative)] ?? "application/octet-stream" });
    response.end(body);
  });
  return new Promise((accept) => {
    server.listen(0, "127.0.0.1", () => accept({ server, port: server.address().port }));
  });
}

/**
 * Reads the whole rendered document and returns every horizontal-overflow violation plus the hero
 * row measurements the report needs. Runs inside the page, so it is plain DOM code with no imports.
 */
function measureDocument() {
  const TOLERANCE = 1; // scrollWidth/clientWidth are integers; a sub-pixel edge is not a defect.
  const violations = [];
  const describe = (element) => {
    const id = element.id ? `#${element.id}` : "";
    const klass = typeof element.className === "string" && element.className.trim() ? `.${element.className.trim().split(/\s+/).join(".")}` : "";
    return `${element.tagName.toLowerCase()}${id}${klass}`;
  };
  const visuallyHidden = (element, style, rect) =>
    rect.width <= 1 && rect.height <= 1 && (style.overflow === "hidden" || style.overflowX === "hidden" || style.clip !== "auto" || style.clipPath !== "none");

  const viewportRight = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > window.innerWidth) {
    violations.push({
      kind: "page-scroll",
      element: "html",
      detail: `documentElement.scrollWidth ${document.documentElement.scrollWidth} exceeds the ${window.innerWidth}px viewport`,
    });
  }

  for (const element of document.querySelectorAll("body *")) {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
    const rect = element.getBoundingClientRect();
    if (visuallyHidden(element, style, rect)) continue;

    const isScrollContainer = style.overflowX === "auto" || style.overflowX === "scroll";
    if (!isScrollContainer && element.clientWidth > 0 && element.scrollWidth > element.clientWidth + TOLERANCE) {
      violations.push({
        kind: style.overflowX === "hidden" || style.overflowX === "clip" ? "content-clipped" : "content-overflow",
        element: describe(element),
        detail: `scrollWidth ${element.scrollWidth} exceeds clientWidth ${element.clientWidth} (overflow-x ${style.overflowX})`,
      });
    }

    if (rect.width === 0 && rect.height === 0) continue;

    // An element inside a horizontal scroller (the philosophy contents nav, the scenario tabs) or
    // inside a clipping box is past an edge by design: the scroller reaches it, the clipper cuts it,
    // and the clipping box itself is already checked for the content it cuts. Right-edge checks
    // apply only where nothing between the element and the page handles the overflow.
    let handledByAncestor = false;
    for (let ancestor = element.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
      const ancestorOverflow = window.getComputedStyle(ancestor).overflowX;
      if (ancestorOverflow !== "visible") {
        handledByAncestor = true;
        break;
      }
    }

    if (!handledByAncestor && rect.right > viewportRight + TOLERANCE) {
      violations.push({
        kind: "off-screen-right",
        element: describe(element),
        detail: `right edge ${Math.round(rect.right)} is past the ${viewportRight}px viewport`,
      });
    }

    let container = null;
    if (style.position === "fixed") {
      container = { right: viewportRight, name: "viewport" };
    } else {
      let ancestor = style.position === "absolute" && element.offsetParent instanceof Element ? element.offsetParent : element.parentElement;
      // A display:contents or unrendered ancestor has no box; the containing box is the next one up.
      while (ancestor && ancestor !== document.body) {
        const ancestorRect = ancestor.getBoundingClientRect();
        if (ancestorRect.width > 0 || ancestorRect.height > 0) break;
        ancestor = ancestor.parentElement;
      }
      if (ancestor && ancestor !== document.body) {
        container = { right: ancestor.getBoundingClientRect().right, name: describe(ancestor) };
      }
    }
    if (container && !handledByAncestor && rect.right > container.right + TOLERANCE) {
      violations.push({
        kind: "past-container-right",
        element: describe(element),
        detail: `right edge ${Math.round(rect.right)} is past ${container.name}'s right edge ${Math.round(container.right)}`,
      });
    }
  }

  const measure = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, rightEdge: Math.round(rect.right) };
  };
  return {
    violations,
    page: { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth },
    heroActions: measure(".hero-actions"),
    heroSecondaryButton: measure(".hero-actions .button-secondary"),
  };
}

/**
 * Renders every served page under `root` at every width and returns one record per render.
 * `renders` carries the measurements; `violations` carries every failure with its route and width.
 */
export async function runWebsiteRenderCheck({ root = resolve("website"), widths = RENDER_WIDTHS, routes: onlyRoutes = null } = {}) {
  const { chromium } = await import("playwright");
  const allRoutes = await servedRoutes(root);
  const routes = onlyRoutes ? allRoutes.filter(({ route }) => onlyRoutes.includes(route)) : allRoutes;
  const { server, port } = await startStaticServer(resolve(root));
  const browser = await chromium.launch();
  const renders = [];
  const violations = [];
  try {
    const context = await browser.newContext({ viewport: { width: widths[0], height: 900 } });
    const page = await context.newPage();
    for (const { route, file } of routes) {
      for (const width of widths) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`http://127.0.0.1:${port}${route}`, { waitUntil: "networkidle" });
        // Let entrance animations and the hero verb cycle settle so transforms are not mid-flight.
        await page.waitForTimeout(600);
        const result = await page.evaluate(measureDocument);
        renders.push({ route, file, width, ...result });
        for (const violation of result.violations) violations.push({ route, width, ...violation });
      }
    }
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
  return { root: resolve(root), widths, renders, violations };
}

const main = async () => {
  const argv = process.argv.slice(2);
  const option = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? fallback : argv[at + 1];
  };
  const root = resolve(option("root", "website"));
  const widths = option("widths", RENDER_WIDTHS.join(",")).split(",").map(Number);
  const result = await runWebsiteRenderCheck({ root, widths });
  const jsonPath = option("json", null);
  if (jsonPath) await writeFile(resolve(jsonPath), `${JSON.stringify(result, null, 2)}\n`);

  process.stdout.write(`rendered ${result.renders.length} pages x widths (${widths.join(", ")}) from ${root}\n`);
  for (const violation of result.violations) {
    process.stdout.write(`FAIL ${violation.route} @${violation.width}px ${violation.kind} ${violation.element}: ${violation.detail}\n`);
  }
  if (result.violations.length === 0) process.stdout.write("no horizontal overflow at any width\n");
  process.exit(result.violations.length === 0 ? 0 : 1);
};

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) await main();
