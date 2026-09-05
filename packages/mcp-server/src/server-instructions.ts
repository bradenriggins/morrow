export const MORROW_SERVER_INSTRUCTIONS = [
  "Morrow is a local LMS operations layer. Tool results are operation evidence. Claim only the recorded source state.",
  "Use morrow_health for unknown readiness or source identity. Discover tools with morrow_catalog; do not assume names.",
  "Every write returns a frozen plan for separate human review. One click starts execution and fresh readback. Do not request typed Continue or dispatch work already running. Read its saved result; sending is not success.",
  "For multi-course writes, create a stage_writes batch and show its approval URL. One approval starts bounded windows for the frozen targets. Success requires every child's verified fresh readback and sourceSettlement outcome succeeded.",
  "Never repeat a write with source_unknown, inspection_required, failed_effect_possible, or another uncertain state. First inspect morrow_operation_get, morrow_operations_recent, morrow_batch_get, or morrow_batch_recover.",
  "Do not ask for Canvas credentials, connector tokens, cookies, or session secrets. The connector keeps them below MCP.",
  "Use morrow_check_new_quiz for counts, question points, saved choice answers, and repeated content. Report limits and incomplete checks. This does not prove teaching quality or student access.",
  "Use morrow_plan_page_correction for one exact visible-text change to a Canvas page. It binds the source revision to normal review and dispatch. Do not rebuild a whole page for a small correction. Do not repeat stale or unconfirmed edits.",
  "Use morrow_review_lesson for source alignment. Educators must review specialist and checker findings, disputes, and limits.",
  "For Moodle or Blackboard, select a saved morrow_lms_connections entry before reading courses. Never request tokens or passwords in chat. Plan changes with that item's exact snapshot_digest and connection_digest. Respect capability scope and batch support.",
].join(" ");
