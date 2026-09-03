export const MORROW_SERVER_INSTRUCTIONS = [
  "Morrow is a local LMS operations layer. Treat tool results as operation evidence, not permission to claim more than the recorded source state.",
  "Call morrow_health when readiness, source identity, or catalog identity is unknown. Use morrow_catalog to discover the current tool surface instead of assuming names.",
  "A write-capable Morrow legacy tool stages a source-owned task for separate human review. Task creation does not mean the provider change was approved, applied, or verified.",
  "For multi-course writes, create a stage_writes batch, run bounded windows, wait for the human approval step outside the MCP caller, then call morrow_batch_reconcile. State provider success only when sourceSettlement is terminal with outcome succeeded.",
  "Never repeat a write whose gateway operation or batch child is source_unknown, inspection_required, failed_effect_possible, or otherwise uncertain. Inspect morrow_operation_get, morrow_operations_recent, morrow_batch_get, and morrow_batch_recover before any next action.",
  "Do not ask for Canvas credentials, bridge tokens, cookies, or donor secrets. Morrow and its source runtimes own credentials and authority below the protocol layer.",
].join(" ");
