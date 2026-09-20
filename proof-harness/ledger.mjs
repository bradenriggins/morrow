// The evidence ledger. One row per operation: what ran, what the LMS answered when it was read
// back, what was cleaned up, and the verdict. A row is written the moment it is known, so a run
// that stops keeps everything it proved.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const PATH = new URL("ledger.json", import.meta.url);

export function loadLedger() {
  if (existsSync(PATH)) {
    try { return JSON.parse(readFileSync(PATH, "utf8")); } catch { /* start a fresh ledger */ }
  }
  return { schema: "morrow.proof-ledger.v1", startedAt: new Date().toISOString(), rows: {} };
}

export function saveLedger(ledger) {
  ledger.updatedAt = new Date().toISOString();
  writeFileSync(PATH, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
}

/**
 * One evidence row. `verdict` is PASS only when the LMS itself confirmed the effect;
 * BLOCKED records a reproducible reason; FAIL records a real defect.
 */
export function recordRow(ledger, id, row) {
  ledger.rows[id] = { id, at: new Date().toISOString(), ...row };
  saveLedger(ledger);
  return ledger.rows[id];
}

export function summarize(ledger) {
  const counts = {};
  for (const row of Object.values(ledger.rows)) counts[row.verdict] = (counts[row.verdict] ?? 0) + 1;
  return counts;
}

export { PATH as LEDGER_PATH };
