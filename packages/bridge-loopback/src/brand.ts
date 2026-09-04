import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";

const assets: Record<string, string> = {
  "theme.css": "text/css; charset=utf-8",
  "review.css": "text/css; charset=utf-8",
  "morrow.png": "image/png",
  "GoogleSansFlex-latin.woff2": "font/woff2",
};

export const brandHead = '<link rel="icon" href="/morrow-brand/morrow.png"><link rel="stylesheet" href="/morrow-brand/theme.css"><link rel="stylesheet" href="/morrow-brand/review.css">';
export const brandHeader = '<div class="brand"><img src="/morrow-brand/morrow.png" width="38" height="38" alt=""><div><strong>Morrow</strong><span>Your Canvas work, connected</span></div></div>';

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
