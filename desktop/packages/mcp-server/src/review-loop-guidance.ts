import type { McpServer } from "@modelcontextprotocol/server";

export const REVIEW_LOOP_GUIDANCE = `# The review loop

A plan that needs a person's review does not wait inside the assistant's own confirm form. When a change reports \`effectState: "awaiting_approval"\`, the one review link is in \`receipts.approvalUrl\`.

## What to say and do

- Say one sentence to the person: the change is ready and waits for their review.
- Give the person exactly one link, named after the change. Do not hand them a raw operation id or an unnamed URL.
- Call \`morrow_operation_wait\` with the operation or batch id. Do not ask the person whether they are done, and do not poll by re-reading the operation yourself.
- A person who has not answered yet is not a failure. Say the review is still open and call \`morrow_operation_wait\` again when they are ready.

## Batch several changes of one kind

When several changes share one kind, freeze them as one batch with \`stage_writes\` and give the person one review link for the whole batch, not one link for each change.

## Never a typed confirmation

Morrow approves a change in one place: its review page. Never ask the person to type a word, a code, or "yes" in the assistant to approve a change. A typed confirmation in the assistant is not an approval Morrow recognizes.
`;

export function registerReviewLoopGuidanceResource(server: McpServer): void {
  server.registerResource("review-loop-guidance", "morrow://guidance/review-loop-v1", {
    title: "The review loop: link, wait, batch, never a typed confirmation",
    mimeType: "text/markdown",
  }, async (uri) => ({ contents: [{ uri: uri.href, text: REVIEW_LOOP_GUIDANCE }] }));
}
