#!/usr/bin/env node

/*
 * Every Canvas write addresses its target through path ids. This reads the frozen
 * Canvas API catalog and pairs each of those ids with the GET route that reads the
 * same object, so a review can name what a change touches instead of showing an id.
 * The catalog itself is not rebuilt here: this reads what is already published.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG = resolve(HERE, "../artifacts/canvas-api/canvas-api-catalog.json");
const OUTPUT = resolve(HERE, "../packages/canvas-api-catalog/src/entity-read-routes.ts");

const PLACEHOLDER = /^\{(.+)\}$/;

function shape(path) {
  return path.split("/").map((segment) => (PLACEHOLDER.test(segment) ? "{}" : segment)).join("/");
}

/** The Canvas input name for one path placeholder, which the wire name spells. */
function inputNameFor(operation, wireName) {
  const parameter = operation.parameters.find((entry) => entry.location === "path" && entry.wireName === wireName);
  return parameter ? parameter.inputName : null;
}

function singular(word) {
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/zzes$/.test(word)) return word.slice(0, -3);
  if (/(ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (/ss$/.test(word)) return word;
  if (/s$/.test(word)) return word.slice(0, -1);
  return word;
}

function label(segment) {
  const words = singular(segment).split("_").filter(Boolean);
  if (words.length === 0) return "Item";
  return [words[0][0].toUpperCase() + words[0].slice(1), ...words.slice(1)].join(" ");
}

/**
 * The listing that holds the record one write addresses, for a route addressed by
 * that record's own id. A later check reads it to settle a deletion the record's
 * own route cannot answer, because Canvas keeps some deleted records readable.
 */
export function recordListings(catalog) {
  const reads = new Map();
  for (const operation of catalog.operations) {
    if (operation.method !== "GET") continue;
    const key = shape(operation.path);
    if (!reads.has(key)) reads.set(key, []);
    reads.get(key).push(operation);
  }
  const listings = {};
  for (const operation of catalog.operations) {
    if (operation.method !== "DELETE") continue;
    const segments = operation.path.split("/").filter(Boolean);
    const last = PLACEHOLDER.exec(segments.at(-1) || "");
    if (!last) continue;
    const targetField = inputNameFor(operation, last[1]);
    const parentKey = `/${segments.slice(0, -1).map((value) => (PLACEHOLDER.test(value) ? "{}" : value)).join("/")}`;
    const candidates = reads.get(parentKey) || [];
    if (!targetField || candidates.length !== 1) continue;
    const listing = candidates[0];
    const listingSegments = listing.path.split("/").filter(Boolean);
    const args = {};
    let exact = true;
    for (const [position, segment] of listingSegments.entries()) {
      const placeholder = PLACEHOLDER.exec(segment);
      if (!placeholder) continue;
      const listingField = inputNameFor(listing, placeholder[1]);
      const writePlaceholder = PLACEHOLDER.exec(segments[position]);
      const writeField = writePlaceholder ? inputNameFor(operation, writePlaceholder[1]) : null;
      if (!listingField || !writeField) { exact = false; break; }
      args[listingField] = writeField;
    }
    if (!exact) continue;
    listings[operation.toolName] = { read: listing.toolName, arguments: args, targetField };
  }
  return listings;
}

/**
 * The comparator a write's own contract declares, when it needs no argument from
 * the request. A later check can rebuild it from the catalog alone, so a change
 * whose comparator was never retained, or was retained by an older build, is
 * still settled by reading rather than by asking a person to confirm it.
 */
export function declaredReadbacks(catalog, planBrowserReadback) {
  const declared = {};
  for (const operation of catalog.operations) {
    if (operation.readOnly) continue;
    const inputs = (operation.parameters || []).filter((parameter) => parameter.location === "path");
    if (inputs.length !== 0) continue;
    let plan = null;
    try { plan = planBrowserReadback(catalog.operations, operation, {}, {}); } catch { plan = null; }
    if (!plan || plan.strategy !== "collection-empty" || plan.assertions.length !== 0) continue;
    declared[operation.toolName] = {
      read: plan.readOperation.toolName,
      arguments: { ...plan.arguments },
      strategy: plan.strategy,
    };
  }
  return declared;
}

export function entityReadRoutes(catalog) {
  const reads = new Map();
  for (const operation of catalog.operations) {
    if (operation.method !== "GET") continue;
    const key = shape(operation.path);
    if (!reads.has(key)) reads.set(key, []);
    reads.get(key).push(operation);
  }
  const routes = {};
  for (const operation of catalog.operations) {
    if (operation.method === "GET") continue;
    const segments = operation.path.split("/").filter(Boolean);
    const targets = [];
    for (const [index, segment] of segments.entries()) {
      const placeholder = PLACEHOLDER.exec(segment);
      if (!placeholder) continue;
      const field = inputNameFor(operation, placeholder[1]);
      const key = `/${segments.slice(0, index + 1).map((value) => (PLACEHOLDER.test(value) ? "{}" : value)).join("/")}`;
      const candidates = reads.get(key) || [];
      // An ambiguous prefix names nothing: two GET routes on one path cannot both
      // be the read that confirms this object.
      if (!field || candidates.length !== 1) continue;
      const read = candidates[0];
      const readSegments = read.path.split("/").filter(Boolean);
      const args = {};
      let exact = true;
      for (const [position, readSegment] of readSegments.entries()) {
        const readPlaceholder = PLACEHOLDER.exec(readSegment);
        if (!readPlaceholder) continue;
        const readField = inputNameFor(read, readPlaceholder[1]);
        const writePlaceholder = PLACEHOLDER.exec(segments[position]);
        const writeField = writePlaceholder ? inputNameFor(operation, writePlaceholder[1]) : null;
        if (!readField || !writeField) { exact = false; break; }
        args[readField] = writeField;
      }
      if (!exact) continue;
      const resource = segments.slice(0, index).reverse().find((value) => !PLACEHOLDER.test(value)) || "";
      targets.push({ field, label: label(resource), read: read.toolName, arguments: args });
    }
    // One argument names one object. A field the route repeats cannot be told
    // apart in the request, so it is left unnamed rather than guessed.
    const unique = targets.filter((target) => targets.filter((entry) => entry.field === target.field).length === 1);
    if (unique.length) routes[operation.toolName] = unique;
  }
  return routes;
}

function serialize(routes, listings, declared) {
  const declaredLines = Object.keys(declared).sort().map((tool) => {
    const entry = declared[tool];
    return `  ${JSON.stringify(tool)}: { read: ${JSON.stringify(entry.read)}, arguments: { ${Object.entries(entry.arguments).map(([name, value]) => `${JSON.stringify(name)}: ${JSON.stringify(value)}`).join(", ")} }, strategy: ${JSON.stringify(entry.strategy)} },`;
  }).join("\n");
  const listingLines = Object.keys(listings).sort().map((tool) => {
    const entry = listings[tool];
    return `  ${JSON.stringify(tool)}: { read: ${JSON.stringify(entry.read)}, arguments: { ${Object.entries(entry.arguments).map(([name, value]) => `${JSON.stringify(name)}: ${JSON.stringify(value)}`).join(", ")} }, targetField: ${JSON.stringify(entry.targetField)} },`;
  }).join("\n");
  const lines = Object.keys(routes).sort().map((tool) => {
    const entries = routes[tool].map((target) => `{ field: ${JSON.stringify(target.field)}, label: ${JSON.stringify(target.label)}, read: ${JSON.stringify(target.read)}, arguments: { ${Object.entries(target.arguments).map(([name, value]) => `${JSON.stringify(name)}: ${JSON.stringify(value)}`).join(", ")} } }`);
    return `  ${JSON.stringify(tool)}: [\n${entries.map((entry) => `    ${entry},`).join("\n")}\n  ],`;
  });
  return `/*
 * Generated by scripts/generate-canvas-entity-read-routes.mjs from the published
 * Canvas API catalog. Each Canvas write lists the objects its route addresses and
 * the GET route that reads each one, so a review names the target instead of
 * showing a bare id. Run the generator after the catalog changes.
 */

export interface CanvasEntityReadRoute {
  /** The write argument that carries this object's id. */
  readonly field: string;
  /** How the object is named in a review, from the Canvas resource it belongs to. */
  readonly label: string;
  /** The Canvas read that confirms the object and supplies its name. */
  readonly read: string;
  /** The read's arguments, each taken from the write argument named here. */
  readonly arguments: Readonly<Record<string, string>>;
}

const ROUTES = Object.freeze<Record<string, readonly CanvasEntityReadRoute[]>>({
${lines.join("\n")}
});

/** The objects one Canvas write addresses, in the order its route names them. */
export function canvasEntityReadRoutes(toolName: string): readonly CanvasEntityReadRoute[] {
  return ROUTES[toolName] || [];
}

export interface CanvasRecordListing {
  /** The Canvas read that lists the collection holding the deleted record. */
  readonly read: string;
  /** The listing's arguments, each taken from the write argument named here. */
  readonly arguments: Readonly<Record<string, string>>;
  /** The write argument that carries the deleted record's id. */
  readonly targetField: string;
}

const LISTINGS = Object.freeze<Record<string, CanvasRecordListing>>({
${listingLines}
});

/**
 * The listing that settles one Canvas deletion the record's own route cannot
 * answer, because Canvas keeps some deleted records readable by id. A deletion
 * addressed by anything but a record id, or one whose collection Canvas does not
 * list, has none.
 */
export function canvasRecordListing(toolName: string): CanvasRecordListing | null {
  return LISTINGS[toolName] || null;
}

export interface CanvasDeclaredReadback {
  /** The Canvas read that proves this change. */
  readonly read: string;
  /** The read's fixed arguments, which need nothing from the request. */
  readonly arguments: Readonly<Record<string, string>>;
  /** How the reading is compared. */
  readonly strategy: string;
}

const DECLARED = Object.freeze<Record<string, CanvasDeclaredReadback>>({
${declaredLines}
});

/**
 * The comparator one Canvas write declares that needs nothing from the request.
 * A later check rebuilds it from the current contract, so a change whose own
 * comparator was never retained is still settled by reading Canvas.
 */
export function canvasDeclaredReadback(toolName: string): CanvasDeclaredReadback | null {
  return DECLARED[toolName] || null;
}
`;
}

export async function main(argv = process.argv.slice(2)) {
  const catalog = JSON.parse(await readFile(CATALOG, "utf8"));
  const { planBrowserReadback } = await import("../packages/canvas-api-catalog/dist/readback-plan.js");
  const text = serialize(entityReadRoutes(catalog), recordListings(catalog), declaredReadbacks(catalog, planBrowserReadback));
  if (argv.includes("--check")) {
    const current = await readFile(OUTPUT, "utf8").catch(() => "");
    if (current !== text) {
      process.stderr.write(`Canvas entity read routes are stale: ${OUTPUT}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify({ path: OUTPUT, state: "current" })}\n`);
    return;
  }
  await writeFile(OUTPUT, text, "utf8");
  process.stdout.write(`${JSON.stringify({ path: OUTPUT, writes: (text.match(/^  "/gm) || []).length })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
