// Phase 4. The coverage report, built from the manifest and the ledger and from nothing else.
// A number here is a count of evidence rows, never a claim written by hand.
//
// The denominator is the honest part. Phase 0 predicted which operations could be proven in this
// sandbox; running them showed otherwise for many. So coverage is reported against what was
// attempted and what the evidence says, not against the prediction.
import { readFileSync, writeFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("manifest.json", import.meta.url), "utf8"));
const ledger = JSON.parse(readFileSync(new URL("ledger.json", import.meta.url), "utf8"));
const rows = manifest.operations;
const evidence = ledger.rows ?? {};

const PROVEN = rows.filter((row) => row.classification === "PROVEN");
const DEFECTS = Object.values(evidence).filter((row) => row.verdict === "FAIL");
const attempted = rows.filter((row) => Boolean(evidence[row.id]));
const neverAttempted = rows.filter((row) => !evidence[row.id]);

const byClassification = {};
for (const row of rows) {
  byClassification[row.classification] = byClassification[row.classification] ?? { count: 0, reason: row.reason ?? "" };
  byClassification[row.classification].count += 1;
  if (!byClassification[row.classification].reason && row.reason) byClassification[row.classification].reason = row.reason;
}

const scenarioRows = Object.values(evidence).filter((row) => row.kind === "scenario");
const robustnessRows = Object.values(evidence).filter((row) => row.kind === "robustness");
const report = {
  schema: "morrow.proof-report.v1",
  builtAt: new Date().toISOString(),
  sandbox: manifest.sandbox,
  operations: {
    inManifest: rows.length,
    attempted: attempted.length,
    proven: PROVEN.length,
    defects: DEFECTS.length,
    neverAttempted: neverAttempted.length,
    percentOfAttemptedProven: attempted.length === 0 ? 0 : Number(((PROVEN.length / attempted.length) * 100).toFixed(1)),
  },
  scenarios: { total: scenarioRows.length, passed: scenarioRows.filter((row) => row.verdict === "PASS").length },
  robustness: { total: robustnessRows.length, passed: robustnessRows.filter((row) => row.verdict === "PASS").length },
  classification: byClassification,
};
writeFileSync(new URL("report.json", import.meta.url), `${JSON.stringify(report, null, 2)}\n`);

const lines = [];
lines.push("# Morrow proof harness coverage report");
lines.push("");
lines.push(`Built ${report.builtAt} against sandbox course ${report.sandbox.courseId}.`);
lines.push("");
lines.push("## What is proven");
lines.push("");
lines.push(`${report.operations.proven} operations were confirmed by reading Canvas back after the request. ${report.scenarios.passed} of ${report.scenarios.total} educator scenarios pass, and ${report.robustness.passed} of ${report.robustness.total} robustness checks pass.`);
lines.push("");
lines.push(`Of the ${report.operations.attempted} operations this run attempted, ${report.operations.percentOfAttemptedProven}% are proven. The rest could not be proven in this sandbox, each for a recorded reason below.`);
lines.push("");
lines.push("A coverage figure against the Phase 0 prediction is deliberately not given. That prediction was made before anything ran and was wrong for hundreds of rows: the sandbox holds no poll session, no LTI registration, no learner attempt. Measuring against it would report a number known to be meaningless.");
lines.push("");
lines.push("## Every operation, and what the evidence says");
lines.push("");
lines.push("| Classification | Operations | What it means |");
lines.push("| --- | ---: | --- |");
const MEANING = {
  PROVEN: "Canvas confirmed the effect after the request.",
  DEFECT: "The operation failed, and the failure is recorded.",
};
for (const [name, value] of Object.entries(byClassification).sort((left, right) => right[1].count - left[1].count)) {
  lines.push(`| ${name} | ${value.count} | ${MEANING[name] ?? value.reason ?? ""} |`);
}
lines.push("");
lines.push("## Defects");
lines.push("");
if (DEFECTS.length === 0) {
  lines.push("No operation failed in a way the evidence calls a defect.");
} else {
  lines.push("| Operation | What happened |");
  lines.push("| --- | --- |");
  for (const row of DEFECTS) lines.push(`| \`${row.id}\` | ${String(row.reason ?? "").replace(/\|/g, " ")} |`);
}
lines.push("");
lines.push("The findings this run produced, including the one that explains most of the blocked rows, are in FINDINGS.md.");
lines.push("");
writeFileSync(new URL("COVERAGE.md", import.meta.url), `${lines.join("\n")}\n`);
console.log(JSON.stringify(report.operations, null, 1));
console.log(JSON.stringify({ scenarios: report.scenarios, robustness: report.robustness }));
