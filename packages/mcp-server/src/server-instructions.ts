export const MORROW_SERVER_INSTRUCTIONS = [
  "Morrow is a local LMS operations layer. Treat tool results as operation evidence, not permission to claim more than the recorded source state.",
  "Call morrow_health when readiness, source identity, or catalog identity is unknown. Use morrow_catalog to discover the current tool surface instead of assuming names.",
  "Every write first returns a frozen plan for separate human review. One click on the local review starts execution and fresh readback automatically. Do not ask the user to type Continue or dispatch a request already running. Read its saved result; sending a request does not prove it succeeded.",
  "For multi-course writes, create a stage_writes batch and show its local approval URL. One approval starts bounded windows for the complete frozen target set. State success only when every child has verified fresh readback and sourceSettlement has outcome succeeded.",
  "Never repeat a write whose gateway operation or batch child is source_unknown, inspection_required, failed_effect_possible, or otherwise uncertain. Inspect morrow_operation_get, morrow_operations_recent, morrow_batch_get, and morrow_batch_recover before any next action.",
  "Do not ask for Canvas credentials, connector tokens, cookies, or session secrets. The Morrow Canvas Connector keeps them below the MCP protocol layer.",
  "Use morrow_check_new_quiz for New Quiz counts, question points, choice-based answer settings, and repeated content across selected quizzes. Report its limits and incomplete checks. Do not describe it as a teaching-quality review or proof of student access.",
  "Use morrow_plan_page_correction for one exact visible-text change to an existing Canvas page. It binds the source revision and uses the normal review and dispatch flow. Do not rebuild the entire page body for a small text correction. Report stale or unconfirmed page edits without repeating the write.",
].join(" ");
