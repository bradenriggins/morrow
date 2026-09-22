// Settling one unresolved change the way a person would: Morrow checks it again,
// and what Morrow still cannot confirm is closed against a fresh read of the same
// collection. A change left unresolved holds its target, so the next change to
// that collection waits on this.
import { OPERATIONS, SB, fillArguments } from "./catalog.mjs";

function listingFor(operation) {
  if (!operation) return null;
  const path = String(operation.path || "");
  // A change that names an object is settled by reading that object. Only a
  // change that names none is settled by reading the collection it went into.
  const collection = path.replace(/\/\{[A-Za-z_]+\}$/, "");
  return OPERATIONS.find((candidate) => candidate.readOnly && candidate.method === "GET" && candidate.path === path)
    || OPERATIONS.find((candidate) => candidate.readOnly && candidate.method === "GET" && candidate.path === collection);
}

export async function settleOperation(callTool, operationId, toolName, pool) {
  const checked = (await callTool("morrow_operation_verify", { operation_id: operationId }))?.structuredContent ?? {};
  if (checked.effectState === "verified") return "verified";
  // Morrow names the reading that settles this change and the exact item it
  // addressed. Reading anything else reads another object.
  const current = (await callTool("morrow_operation_get", { operation_id: operationId }))?.structuredContent ?? {};
  const named = current.settleRead && typeof current.settleRead.tool === "string" ? current.settleRead : null;
  const operation = OPERATIONS.find((candidate) => candidate.toolName === toolName);
  // A change Morrow cannot read back is closed on the person's own check, so any
  // fresh reading of this course carries the confirmation.
  const read = named
    ? { toolName: named.tool }
    : listingFor(operation) || OPERATIONS.find((candidate) => candidate.toolName === "canvas_get_single_course_courses");
  if (!read) return "no_readback_route";
  const filled = named ? { args: { ...named.arguments } } : fillArguments(read, pool);
  if (filled.missing) return "no_ids_for_readback";
  const answered = (await callTool("morrow_capability_read", { name: read.toolName, arguments: { ...filled.args, _morrow: { source_binding_id: SB } } }))?.structuredContent ?? {};
  if (answered.status !== "succeeded") return `settling_read_refused:${answered.data?.code ?? answered.status}`;
  const recent = (await callTool("morrow_operations_recent", { limit: 50 }))?.structuredContent ?? {};
  const evidence = (recent.operations || []).find((row) => row.publicToolName === read.toolName);
  if (!evidence?.upstreamResultDigest) return "no_read_evidence";
  const closed = (await callTool("morrow_operation_close_unresolved", {
    operation_id: operationId,
    observed_state: evidence.upstreamResultDigest,
    confirmed_by_person: true,
  }))?.structuredContent ?? {};
  return closed.effectState === "closed_by_person" || closed.state === "closed_by_person" ? "closed" : "still_open";
}
