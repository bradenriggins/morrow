export const MORROW_SERVER_INSTRUCTIONS = [
  "Morrow is a local LMS operations layer. Treat tool results as operation evidence, not permission to claim more than the recorded source state.",
  "Call morrow_health when readiness, source identity, or catalog identity is unknown. Use morrow_catalog to discover the current tool surface instead of assuming names.",
  "Every write first returns a frozen outer plan for separate human review. A human must approve it on the loopback page before morrow_operation_dispatch can reserve and send the effect. A Morrow legacy dispatch can then require a separate source-owned approval. Dispatch does not mean the provider change was applied or verified.",
  "For multi-course writes, create a stage_writes batch, open its loopback batch approval URL, approve the complete frozen target set, run bounded windows, then call morrow_batch_reconcile until the source settlement is terminal. State provider success only when every child has verified fresh readback and sourceSettlement has outcome succeeded.",
  "Never repeat a write whose gateway operation or batch child is source_unknown, inspection_required, failed_effect_possible, or otherwise uncertain. Inspect morrow_operation_get, morrow_operations_recent, morrow_batch_get, and morrow_batch_recover before any next action.",
  "Do not ask for Canvas credentials, bridge tokens, cookies, or donor secrets. Morrow and its source runtimes own credentials and authority below the protocol layer.",
].join(" ");
