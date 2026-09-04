export const MORROW_SERVER_INSTRUCTIONS = [
  "Morrow is a local LMS operations layer. Treat tool results as operation evidence, not permission to claim more than the recorded source state.",
  "Call morrow_health when readiness, source identity, or catalog identity is unknown. Use morrow_catalog to discover the current tool surface instead of assuming names.",
  "Every write first returns a frozen plan for separate human review. A human must approve it on the loopback page before morrow_operation_dispatch can reserve and send the effect. The Canvas connector then sends the request once and performs a fresh readback. Dispatch does not mean the provider change was applied or verified.",
  "For multi-course writes, create a stage_writes batch, open its loopback batch approval URL, approve the complete frozen target set, and run bounded windows. State provider success only when every child has verified fresh readback and sourceSettlement has outcome succeeded.",
  "Never repeat a write whose gateway operation or batch child is source_unknown, inspection_required, failed_effect_possible, or otherwise uncertain. Inspect morrow_operation_get, morrow_operations_recent, morrow_batch_get, and morrow_batch_recover before any next action.",
  "Do not ask for Canvas credentials, connector tokens, cookies, or session secrets. The Morrow Canvas Connector keeps them below the MCP protocol layer.",
  "Use morrow_check_new_quiz for New Quiz counts, question points, choice-based answer settings, and repeated content across selected quizzes. Report its limits and incomplete checks. Do not describe it as a teaching-quality review or proof of student access.",
].join(" ");
