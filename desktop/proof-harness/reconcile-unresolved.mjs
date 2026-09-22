import { writeFileSync } from "node:fs";
import { connect } from "./connect.mjs";
import { makeTools } from "./lib/tools.mjs";

const output = process.env.MORROW_RECONCILE_REPORT || "/private/tmp/morrow-reconcile-unresolved.json";
const { client, close } = await connect("morrow-proof-reconcile", { waitForBinding: true });
const { callTool } = makeTools(client);

try {
  const operations = [];
  let cursor;
  do {
    const page = await callTool("morrow_operation_list", {
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    const content = page?.structuredContent ?? {};
    operations.push(...(Array.isArray(content.operations) ? content.operations : []));
    cursor = typeof content.nextCursor === "string" ? content.nextCursor : undefined;
  } while (cursor);

  const unresolved = operations.filter((operation) =>
    ["awaiting_verification", "applied_or_unknown"].includes(String(operation.state)));
  const results = [];
  for (const operation of unresolved) {
    const operationId = String(operation.operationId ?? "");
    if (!operationId) continue;
    const response = await callTool("morrow_operation_reconcile", { operation_id: operationId }, 240_000)
      .catch((error) => ({ isError: true, error: String(error) }));
    const structured = response?.structuredContent ?? {};
    results.push({
      operationId,
      tool: operation.tool ?? null,
      before: operation.state,
      after: structured.effectState ?? structured.state ?? null,
      phase: structured.phase ?? null,
      verification: structured.verification ?? null,
      attention: structured.attention ?? null,
      code: structured.data?.code ?? structured.code ?? null,
      isError: response?.isError === true,
      error: response?.error ?? null,
    });
    process.stdout.write(`${operationId}\t${operation.state}\t${results.at(-1).after ?? "unknown"}\n`);
  }
  const report = {
    schema: "morrow.proof-reconcile.v1",
    checkedAt: new Date().toISOString(),
    unresolvedBefore: unresolved.length,
    results,
  };
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, unresolvedBefore: unresolved.length })}\n`);
} finally {
  await close();
}
