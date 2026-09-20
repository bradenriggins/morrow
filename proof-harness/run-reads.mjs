// Phase 1, reads. Every read the manifest calls provable, run live against the sandbox, with the
// answer Canvas gave recorded as its evidence. A read that cannot be addressed because the course
// holds no such object is BLOCKED with that reason, never a silent skip.
import { readFileSync } from "node:fs";
import { OPERATIONS, cachedSeedPool, fillArguments, harvestSeeds } from "./lib/catalog.mjs";
import { makeTools } from "./lib/tools.mjs";
import { connect, SANDBOX } from "./connect.mjs";
import { loadLedger, recordRow, summarize } from "./ledger.mjs";

const manifest = JSON.parse(readFileSync(new URL("manifest.json", import.meta.url), "utf8"));
const PROVABLE = new Set(manifest.operations
  .filter((row) => row.kind === "catalog" && row.platform === "canvas" && row.readOnly
    && ["PROVABLE", "DESTRUCTIVE", "BROWSER-ONLY"].includes(row.classification))
  .map((row) => row.id));

// Morrow keeps a few Canvas routes for its own use behind a named capability that applies the
// learner privacy boundary. They are in the catalog and are deliberately not callable by name.
const PRIVATE_SOURCE = new Set([
  "canvas_get_all_quiz_submissions", "canvas_transfer_course_file",
  "canvas_new_quiz_hot_spot_image", "canvas_send_private_conversation",
]);

const slice = Number(process.env.PROOF_SLICE ?? 0);
const slices = Number(process.env.PROOF_SLICES ?? 1);
const ledger = loadLedger();
const { client, close } = await connect(`morrow-proof-reads-${slice}`);
const { log, read } = makeTools(client, new URL(`run-reads-${slice}.log`, import.meta.url));

try {
  const pool = await cachedSeedPool(read, log);
  const reads = OPERATIONS.filter((operation) => operation.readOnly && PROVABLE.has(operation.toolName))
    .sort((left, right) => left.toolName.localeCompare(right.toolName))
    .filter((_, position) => slices === 1 || position % slices === slice);
  await log(`sandbox ${SANDBOX.courseId}: ${reads.length} provable reads, ${Object.keys(ledger.rows).length} rows already held`);

  for (const operation of reads) {
    if (ledger.rows[operation.toolName]) continue;
    if (PRIVATE_SOURCE.has(operation.toolName)) {
      recordRow(ledger, operation.toolName, { phase: 1, kind: "read", verdict: "BLOCKED",
        reason: "Morrow holds this route for its own use behind a named capability that applies the learner privacy boundary; it is deliberately not callable by name." });
      continue;
    }
    const capped = operation.parameters.some((parameter) => parameter.inputName === "morrow_max_pages") ? { morrow_max_pages: 1 } : {};
    const filled = fillArguments(operation, pool, capped);
    if (filled.missing) {
      recordRow(ledger, operation.toolName, { phase: 1, kind: "read", verdict: "BLOCKED",
        reason: `The sandbox course holds no object to address this read: ${filled.missing.join(", ")}.`, path: operation.path });
      continue;
    }
    // A filled read that carries none of the arguments its own route requires is this harness
    // failing, not Canvas refusing. It stops the run rather than writing a verdict that lies.
    const required = operation.parameters.filter((parameter) => parameter.location === "path" || parameter.required);
    if (required.length > 0 && Object.keys(filled.args ?? {}).length === 0) {
      throw new Error(`harness filled no arguments for ${operation.toolName}, which needs ${required.map((parameter) => parameter.inputName).join(", ")}`);
    }
    let answer;
    try {
      answer = await Promise.race([
        read(operation.toolName, filled.args),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, code: "proof_timeout" }), 90_000)),
      ]);
    } catch (error) {
      answer = { ok: false, code: "threw", error: String(error).slice(0, 200) };
    }
    if (answer.ok) {
      const data = answer.data;
      const count = Array.isArray(data) ? data.length : data && typeof data === "object" ? 1 : 0;
      recordRow(ledger, operation.toolName, { phase: 1, kind: "read", verdict: "PASS",
        executed: { tool: operation.toolName, arguments: filled.args },
        readback: { source: "canvas", answered: true, records: count }, path: operation.path });
      harvestSeeds(operation, answer.data, pool);
    } else {
      recordRow(ledger, operation.toolName, { phase: 1, kind: "read", verdict: "BLOCKED",
        reason: `Canvas or Morrow refused this read: ${answer.code ?? "unknown"}.`,
        executed: { tool: operation.toolName, arguments: filled.args },
        ...(answer.detail ? { detail: answer.detail } : {}), path: operation.path });
    }
  }
  await log(`reads complete: ${JSON.stringify(summarize(ledger))}`);
} finally {
  await close();
}
