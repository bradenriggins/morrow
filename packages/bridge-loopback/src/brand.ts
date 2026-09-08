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

function brandAsset(name: string, moduleUrl: string | URL): Buffer | null {
  // Workspace packages resolve three levels up. A packaged pnpm dependency is
  // one level deeper under node_modules/@morrow, while the sealed connector
  // directory remains at the application root.
  for (const relative of ["../../../connector/extension/brand/", "../../../../connector/extension/brand/"]) {
    try {
      return readFileSync(new URL(`${relative}${name}`, moduleUrl));
    } catch {
      // Try the other sealed layout. A missing asset becomes a bounded 404 in
      // the caller instead of ending the connector process.
    }
  }
  return null;
}

export function serveBrandAsset(
  pathname: string,
  response: ServerResponse,
  moduleUrl: string | URL = import.meta.url,
): boolean {
  if (!pathname.startsWith("/morrow-brand/")) return false;
  const name = pathname.slice("/morrow-brand/".length);
  if (!Object.hasOwn(assets, name)) return false;
  const bytes = brandAsset(name, moduleUrl);
  if (!bytes) return false;
  response.writeHead(200, {
    "content-type": assets[name]!,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(bytes);
  return true;
}
