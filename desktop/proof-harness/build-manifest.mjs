// Phase 0. Every registered MCP tool and every catalog operation, each classified for whether
// a live proof is possible at all, written to manifest.json with proof status UNPROVEN.
// Classification is a verdict recorded before anything runs, never a silent skip afterwards.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { canvasAdmissionIsBound, canvasOperationAdmission, canvasReadbackAssessment } from "../connector/extension/generated/canvas-operation-admission.js";
import { connect } from "./connect.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

const CANVAS = read("artifacts/canvas-api/canvas-api-catalog.json");
const MOODLE = existsSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root))
  ? read("connector/extension/generated/moodle-browser-catalog.json") : { operations: [] };

/**
 * Why an operation may not be provable here. Each value is a reason a reader can check,
 * not a label: the harness records one of these or it records live evidence.
 */
const CLASSES = Object.freeze({
  PROVABLE: "PROVABLE",
  BROWSER_ONLY: "BROWSER-ONLY",
  NO_TENANT: "NO-TENANT",
  DESTRUCTIVE: "DESTRUCTIVE",
  EXTERNAL_DEPENDENT: "EXTERNAL-DEPENDENT",
  NEEDS_LEARNER_ATTEMPT: "NEEDS-LEARNER-ATTEMPT",
  HELD: "HELD",
});

/**
 * The admission decision the Bridge itself uses, never a second opinion written here. A
 * classification taken from a field the catalog does not carry would mark every route provable
 * and prove nothing, so every branch below reads the generated contract.
 */
function canvasClass(operation, operations) {
  const admission = canvasOperationAdmission(operation);
  const write = String(admission?.write?.state ?? "not_applicable");
  const authority = String(admission?.authority ?? "");
  const sitewide = authority === "site";
  if (!canvasAdmissionIsBound(admission)) {
    return { classification: CLASSES.NO_TENANT, reason: "The operation binds to no course connection this harness holds." };
  }
  if (write === "held") {
    return { classification: CLASSES.HELD, reason: String(admission?.write?.reason || "Canvas holds this write for the reviewed file transfer.") };
  }
  // A learner record, an attempt, or a statistic exists only after a learner attempt.
  if (/\/quiz_sessions|\/stats\/|quiz_entry_regrades|\/submissions?(?:\/|$)|\/gradebook_history|\/analytics\//.test(String(operation.path || ""))) {
    return { classification: CLASSES.NEEDS_LEARNER_ATTEMPT, reason: "The object exists only after a learner attempt, and the sandbox course has none." };
  }
  // A site read changes nothing: it answers for the connected Canvas site as the signed-in
  // person, so it is proven by running it. A site write is a different thing entirely, and the
  // sandbox course gives no authority for one.
  if (sitewide && operation.readOnly !== true) {
    return { classification: CLASSES.NO_TENANT, reason: "A site write acts on the whole Canvas site; the sandbox course gives no authority to prove it." };
  }
  if (operation.service === "item_bank" || operation.service === "canvas_new_quiz_hot_spot" || operation.service === "canvas_browser") {
    return { classification: CLASSES.BROWSER_ONLY, reason: "The route answers only inside the signed-in browser session that Morrow drives." };
  }
  if (operation.readOnly !== true && (operation.risk === "destructive" || operation.destructive === true)) {
    return { classification: CLASSES.DESTRUCTIVE, reason: "Proved only on an object this harness created in its own sandbox, then removed." };
  }
  if (operation.readOnly !== true && canvasReadbackAssessment(operations, operation).state !== "structurally_exact") {
    return { classification: CLASSES.EXTERNAL_DEPENDENT, reason: "Canvas has no read that shows the saved result, so no readback can prove the effect." };
  }
  return { classification: CLASSES.PROVABLE, reason: "" };
}

function moodleClass() {
  return { classification: CLASSES.NO_TENANT, reason: "No Moodle test tenant is connected to this machine." };
}

const rows = [];
for (const operation of CANVAS.operations) {
  const { classification, reason } = canvasClass(operation, CANVAS.operations);
  rows.push({
    id: operation.toolName,
    kind: "catalog",
    platform: "canvas",
    service: operation.service || "canvas",
    method: operation.method,
    path: operation.path,
    readOnly: operation.readOnly === true,
    classification,
    ...(reason ? { reason } : {}),
    proof: "UNPROVEN",
  });
}
for (const operation of MOODLE.operations || []) {
  const { classification, reason } = moodleClass();
  rows.push({
    id: operation.toolName || operation.nickname,
    kind: "catalog",
    platform: "moodle",
    service: "moodle_browser",
    method: operation.method,
    path: operation.path,
    readOnly: operation.readOnly === true,
    classification,
    reason,
    proof: "UNPROVEN",
  });
}

const { client, close } = await connect("morrow-proof-manifest", { waitForBinding: false });
let tools = [];
try {
  tools = (await client.listTools()).tools ?? [];
} finally {
  await close();
}

const BLACKBOARD = /blackboard/i;
for (const tool of tools) {
  rows.push({
    id: tool.name,
    kind: "mcp_tool",
    platform: BLACKBOARD.test(tool.name) ? "blackboard" : /moodle/i.test(tool.name) ? "moodle" : "canvas",
    readOnly: tool.annotations?.readOnlyHint === true,
    classification: BLACKBOARD.test(tool.name) ? CLASSES.NO_TENANT
      : /moodle/i.test(tool.name) ? CLASSES.NO_TENANT
      : CLASSES.PROVABLE,
    ...(BLACKBOARD.test(tool.name) ? { reason: "No Blackboard test tenant exists." }
      : /moodle/i.test(tool.name) ? { reason: "No Moodle test tenant is connected to this machine." } : {}),
    proof: "UNPROVEN",
  });
}

const counts = {};
for (const row of rows) {
  const key = `${row.kind}:${row.classification}`;
  counts[key] = (counts[key] ?? 0) + 1;
}
const manifest = {
  schema: "morrow.proof-manifest.v1",
  builtAt: new Date().toISOString(),
  sandbox: { provider: "canvas", courseId: process.env.MORROW_PROOF_COURSE || "89585" },
  totals: { operations: rows.length, mcpTools: rows.filter((row) => row.kind === "mcp_tool").length,
    catalogOperations: rows.filter((row) => row.kind === "catalog").length },
  counts,
  operations: rows.sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)),
};
writeFileSync(new URL("manifest.json", import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ totals: manifest.totals, counts }, null, 1));
