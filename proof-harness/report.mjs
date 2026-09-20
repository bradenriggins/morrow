// Phase 4. The coverage report, built from the manifest and the ledger and from nothing else.
// A number here is a count of evidence rows, never a claim written by hand.
import { readFileSync, writeFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("manifest.json", import.meta.url), "utf8"));
const ledger = JSON.parse(readFileSync(new URL("ledger.json", import.meta.url), "utf8"));

const PROVABLE_CLASSES = new Set(["PROVABLE", "DESTRUCTIVE", "BROWSER-ONLY"]);
const rows = manifest.operations;
const provable = rows.filter((row) => PROVABLE_CLASSES.has(row.classification));
const evidence = ledger.rows ?? {};

const verdictOf = (id) => evidence[id]?.verdict ?? null;
const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, NONE: 0 };
for (const row of provable) {
  const verdict = verdictOf(row.id);
  counts[verdict ?? "NONE"] = (counts[verdict ?? "NONE"] ?? 0) + 1;
}

const byClassification = {};
for (const row of rows) {
  const key = row.classification;
  byClassification[key] = byClassification[key] ?? { total: 0, reasons: {} };
  byClassification[key].total += 1;
  if (row.reason) byClassification[key].reasons[row.reason] = (byClassification[key].reasons[row.reason] ?? 0) + 1;
}

const scenarioRows = Object.values(evidence).filter((row) => row.kind === "scenario");
const report = {
  schema: "morrow.proof-report.v1",
  builtAt: new Date().toISOString(),
  sandbox: manifest.sandbox,
  provable: {
    total: provable.length,
    evidenced: counts.PASS,
    failed: counts.FAIL,
    blocked: counts.BLOCKED,
    notYetRun: counts.NONE,
    percentEvidenced: provable.length === 0 ? 0 : Number(((counts.PASS / provable.length) * 100).toFixed(1)),
  },
  scenarios: {
    total: scenarioRows.length,
    passed: scenarioRows.filter((row) => row.verdict === "PASS").length,
    failed: scenarioRows.filter((row) => row.verdict === "FAIL").length,
  },
  classification: byClassification,
  ledgerRows: Object.keys(evidence).length,
};
writeFileSync(new URL("report.json", import.meta.url), `${JSON.stringify(report, null, 2)}\n`);

const lines = [];
lines.push("# Morrow proof harness coverage report");
lines.push("");
lines.push(`Built ${report.builtAt} against sandbox course ${report.sandbox.courseId}.`);
lines.push("");
lines.push("## Provable operations");
lines.push("");
lines.push(`${report.provable.evidenced} of ${report.provable.total} provable operations carry live evidence (${report.provable.percentEvidenced}%).`);
lines.push("");
lines.push("| Verdict | Count |");
lines.push("| --- | ---: |");
lines.push(`| Live evidence (PASS) | ${report.provable.evidenced} |`);
lines.push(`| Defect found (FAIL) | ${report.provable.failed} |`);
lines.push(`| Blocked, with a recorded reason | ${report.provable.blocked} |`);
lines.push(`| Not yet run | ${report.provable.notYetRun} |`);
lines.push("");
lines.push("## Every operation that is not provable here, and why");
lines.push("");
lines.push("| Classification | Operations | Reason |");
lines.push("| --- | ---: | --- |");
for (const [name, value] of Object.entries(byClassification).sort((left, right) => right[1].total - left[1].total)) {
  if (PROVABLE_CLASSES.has(name)) continue;
  const reason = Object.entries(value.reasons).sort((left, right) => right[1] - left[1])[0]?.[0] ?? "";
  lines.push(`| ${name} | ${value.total} | ${reason} |`);
}
lines.push("");
lines.push("## Scenarios");
lines.push("");
lines.push(`${report.scenarios.passed} of ${report.scenarios.total} educator scenarios pass.`);
lines.push("");
writeFileSync(new URL("COVERAGE.md", import.meta.url), `${lines.join("\n")}\n`);
console.log(JSON.stringify(report.provable, null, 1));
console.log(JSON.stringify(report.scenarios));
