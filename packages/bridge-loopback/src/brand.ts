import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";

// Exactly what the pairing and review pages request: the two stylesheets, the knot in `brandHead`
// and `brandHeader`, and the font `theme.css` loads. A name that is not here is not served.
const assets: Record<string, string> = {
  "theme.css": "text/css; charset=utf-8",
  "review.css": "text/css; charset=utf-8",
  "morrow-knot.svg": "image/svg+xml",
  "Manrope-variable.ttf": "font/ttf",
};

export const brandHead = '<link rel="icon" href="/morrow-brand/morrow-knot.svg"><link rel="stylesheet" href="/morrow-brand/theme.css"><link rel="stylesheet" href="/morrow-brand/review.css">';
export const brandHeader = '<div class="brand"><span class="brand-wordmark" aria-label="Morrow"><img class="brand-mark" src="/morrow-brand/morrow-knot.svg" width="36" height="36" alt=""><span aria-hidden="true">morrow</span></span></div>';

export function serveBrandAsset(pathname: string, response: ServerResponse): boolean {
  if (!pathname.startsWith("/morrow-brand/")) return false;
  const name = pathname.slice("/morrow-brand/".length);
  if (!Object.hasOwn(assets, name)) return false;
  const bytes = readFileSync(new URL(`../../../connector/extension/brand/${name}`, import.meta.url));
  response.writeHead(200, {
    "content-type": assets[name]!,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(bytes);
  return true;
}
