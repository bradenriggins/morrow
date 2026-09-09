#!/usr/bin/env node

/**
 * Counts what the Canvas admission and readback contract actually decides, and writes the result to
 * artifacts/canvas-api/canvas-admission-report.json. Documents quote these numbers; the report is
 * the only place they are produced. Run with --check to prove a committed report still matches the
 * catalog and the built contract.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const catalogPath = resolve(root, "artifacts/canvas-api/canvas-api-catalog.json");
const reportPath = resolve(root, "artifacts/canvas-api/canvas-admission-report.json");
const distribution = resolve(root, "packages/canvas-api-catalog/dist");

async function contractModule(name) {
  try {
    return await import(pathToFileURL(resolve(distribution, name)).href);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    throw new Error("The Canvas catalog package is not built. Run pnpm --dir packages/canvas-api-catalog build first.");
  }
}

/** The route with every path parameter erased, so two routes can be compared by shape. */
function normalizedRoute(path) {
  return String(path || "").replace(/\{[^}]+\}/g, "{}").replace(/\/$/, "");
}

/**
 * The first route segment after the API version prefix. `/v1/accounts/{id}/...` is `accounts`;
 * a prefix that is not `v1` stays in the name, so `/api/banks/{id}` is `api/banks`.
 */
function routeFamily(path) {
  const segments = normalizedRoute(path).split("/").filter((segment) => segment && segment !== "{}");
  if (segments[0] === "v1") return segments[1] || "v1";
  if (segments[0] === "quiz" && segments[1] === "v1") return segments[2] || "quiz/v1";
  return segments.slice(0, 2).join("/");
}

/** One placeholder argument per input, so the plan can be built without a real request. */
function structuralArguments(operation) {
  return Object.fromEntries((operation.parameters || []).map((parameter) => [parameter.inputName, "1"]));
}

const STRUCTURAL_RESPONSE = Object.freeze({ id: "1", page_id: "1", rubric_id: "1", url: "morrow-structural-target" });

/** How the planned read relates to the written object. Anything else reads a different resource. */
function readbackRouteTier(executorOwned, operation, plan) {
  // A readback the reviewed executor owns is exact and is not the planner's, so
  // it is its own tier rather than an absent route. The contract decides which
  // operations those are, so this report and the readback assessment can never
  // disagree about it.
  if (executorOwned) return "executor";
  if (!plan) return "none";
  const write = normalizedRoute(operation.path);
  const read = normalizedRoute(plan.readOperation.path);
  if (read === write) return "exact";
  if (read === `${write}/{}`) return "created_child";
  // A create can also read the object it made through the object route its own route hangs from:
  // POST /v1/folders/{}/folders makes a folder, and one folder is read at /v1/folders/{}.
  if (operation.method === "POST" && `${read}/${write.split("/").pop()}` === write) return "created_child";
  if (write === `${read}/{}`) return "parent_collection";
  return "mismatched";
}

function increment(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

/** Highest count first, then name, so the file is byte-identical on every run. */
function byCountThenName(counts) {
  return Object.fromEntries(Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
}

function withFixedKeys(keys, counts) {
  return Object.fromEntries(keys.map((key) => [key, counts[key] || 0]));
}

function buildCanvasAdmissionReport(catalog, contract) {
  const { canvasExecutorOwnedReadback, canvasOperationAdmission, canvasReadbackAssessment, hasNamedCanvasReadback, planBrowserReadback } = contract;
  const operations = catalog.operations;
  const writes = operations.filter((operation) => !operation.readOnly);
  const admittedByCourseTargetKind = {};
  const heldByReason = {};
  const heldByRouteFamily = {};
  const readbackStates = {};
  const readbackBlockers = {};
  const routeTiers = {};
  const withoutExactReadback = [];
  const mismatchedPlans = [];
  const namedReadbacks = [];
  let admitted = 0;

  for (const operation of writes) {
    const admission = canvasOperationAdmission(operation);
    if (admission.write.state === "held") {
      increment(heldByReason, admission.write.reason);
      increment(heldByRouteFamily, routeFamily(operation.path));
      continue;
    }
    if (admission.write.state !== "admitted") continue;
    admitted += 1;
    increment(admittedByCourseTargetKind, admission.courseTarget.kind);
    const assessment = canvasReadbackAssessment(operations, operation, admission);
    increment(readbackStates, assessment.state);
    if (assessment.state === "blocked") increment(readbackBlockers, assessment.reason);
    if (assessment.state !== "structurally_exact") withoutExactReadback.push(operation.toolName);
    if (hasNamedCanvasReadback(operation)) namedReadbacks.push(operation.toolName);
    const executorOwned = canvasExecutorOwnedReadback(operation);
    const plan = executorOwned ? null : planBrowserReadback(operations, operation, structuralArguments(operation), STRUCTURAL_RESPONSE);
    const tier = readbackRouteTier(executorOwned, operation, plan);
    increment(routeTiers, tier);
    if (tier === "mismatched") mismatchedPlans.push(operation.toolName);
  }

  const held = writes.length - admitted;
  return {
    schema: "morrow.canvas-admission-report.v1",
    catalogDigest: catalog.catalogDigest,
    totals: {
      operations: operations.length,
      reads: operations.length - writes.length,
      writes: writes.length,
    },
    admission: {
      admitted,
      admittedByCourseTargetKind: byCountThenName(admittedByCourseTargetKind),
      held,
      heldByReason: byCountThenName(heldByReason),
      heldByRouteFamily: byCountThenName(heldByRouteFamily),
    },
    readback: {
      stateCounts: withFixedKeys(["structurally_exact", "unavailable", "blocked", "unconfirmed"], readbackStates),
      blockedByReason: byCountThenName(readbackBlockers),
      routeTierCounts: withFixedKeys(["exact", "created_child", "parent_collection", "executor", "mismatched", "none"], routeTiers),
      namedReadbackTools: [...namedReadbacks].sort(),
      mismatchedPlanTools: [...mismatchedPlans].sort(),
      admittedWritesWithoutExactReadback: [...withoutExactReadback].sort(),
    },
  };
}

function serializeCanvasAdmissionReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

async function main() {
  const contract = {
    ...await contractModule("operation-admission.js"),
    ...await contractModule("readback-plan.js"),
  };
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const bytes = serializeCanvasAdmissionReport(buildCanvasAdmissionReport(catalog, contract));
  if (check) {
    const current = await readFile(reportPath, "utf8").catch(() => "");
    if (current !== bytes) {
      throw new Error(`${reportPath} no longer matches the catalog and the built contract. Run pnpm canvas:admission:report, then update every document that quotes it.`);
    }
  } else {
    const temporary = `${reportPath}.tmp-${process.pid}`;
    await writeFile(temporary, bytes, "utf8");
    await rename(temporary, reportPath);
  }
  process.stdout.write(`${JSON.stringify({ check, report: reportPath, bytes: Buffer.byteLength(bytes) })}\n`);
}

main().catch((error) => {
  process.stderr.write(`[morrow canvas admission report] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
