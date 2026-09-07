# Canvas catalog generation

Morrow uses one deterministic standalone Canvas catalog. It does not merge live donor registries at runtime.

## Generate

```bash
pnpm catalog:export
```

The generator reads the public Canvas API definition index, retrieves each advertised resource definition, normalizes the operations, adds the explicit Item Bank bridge contract, and writes:

- `artifacts/canvas-api/canvas-api-catalog.json`;
- `connector/extension/generated/canvas-api-catalog.json`.

Both files must be byte-identical.

## Validate

```bash
pnpm catalog:merge
pnpm catalog:check
pnpm morrow catalog stats --json
```

Validation proves:

- stable ordering and byte-identical regeneration;
- unique operation keys and MCP tool names;
- exact decimal-string schemas for 64-bit Canvas IDs;
- an explicit read or write risk class;
- an explicit profile state;
- an explicit connector route and readback owner;
- no enabled MindTap or Connect prefix;
- matching MCP and extension catalog digests;
- all thirteen Item Bank operations are present.

## Drift behavior

The catalog records the provider source digest and last-modified value. A provider definition change changes the Morrow catalog digest. Startup and extension pairing refuse mismatched digests.

Generated definitions are reviewed input, not unchecked authority. Any unsupported schema shape or missing request location must block the affected row until the generator has an explicit sanitation rule.

A regeneration changes the catalog digest, and that invalidates every saved Canvas Edit permission. `connector/extension/src/edit-policy.js` binds `catalogDigest` into the permission scope digest in `scope()`, and `validEditPermission()` rebuilds that digest against the current catalog before it accepts a saved permission. After a regeneration the saved permission no longer matches, so the instructor must grant Edit again. Regenerate for a deliberate catalog change, not opportunistically.

## Sanitation rule: Classic Quiz question answers

The Canvas specification types `question[answers]` as `[Answer]`, which the generic mapper flattens to an array of strings. No Classic Quiz question payload can be rebuilt from that shape, so `classicQuizAnswersParameter()` in `scripts/generate-canvas-api-catalog.mjs` replaces that one schema on two operations:

- `POST /v1/courses/{course_id}/quizzes/{quiz_id}/questions#create_single_quiz_question`;
- `PUT /v1/courses/{course_id}/quizzes/{quiz_id}/questions/{id}#update_existing_quiz_question`.

The replacement is an array of 1 to 100 answer objects. `answer_text` and `answer_weight` are required; `id`, `answer_comments`, `answer_html` and `text_after_answers` are optional; `id` stays an exact decimal string; no other field is accepted. The supported question types are `multiple_choice_question`, `true_false_question`, `multiple_answers_question`, `short_answer_question` and `essay_question`.

Source of the fields: the Canvas Quiz Questions API documentation (`https://canvas.instructure.com/doc/api/quiz_questions.html`) documents the `Answer` model, which supplies `id`, `answer_text`, `answer_weight`, `answer_comments` and `text_after_answers`, and requires `answer_text` and `answer_weight`. `answer_html` is not in that published model. The Canvas answer parsers for multiple-choice and multiple-answers questions read it as the HTML answer body (`app/models/quizzes/quiz_question/answer_parsers/multiple_choice.rb` and `multiple_answers.rb` in `instructure/canvas-lms`, read on 2026-09-06).

This Canvas route is form-encoded, not JSON. `connector/extension/src/canvas-content.js` sends each answer as indexed `question[answers][n][field]` fields starting at 0, and refuses an array the schema does not describe before the request leaves the page. `operationArguments()` in `packages/canvas-api-catalog/src/index.ts` produces the same entries.

Two limits stay open:

- The indexed field encoding is **live-unverified**. No live Canvas tenant has confirmed it, and no live tenant has confirmed that a rebuilt answer round-trips without losing hidden question state.
- The published `Answer` model documents `answer_comments`, but in `instructure/canvas-lms` only the essay parser reads that name. The multiple-choice, true-false, multiple-answers and short-answer parsers read `answer_comment` or `comments`. Morrow sends the documented name, so an answer comment is not proven to survive a rebuild. A repair that must preserve answer comments has to check them in its own post-write readback.

## Discovery

The gateway can register the complete catalog because the default limit is 2,000 tools. Clients should still use `morrow_catalog_search` and bounded catalog pages instead of loading or guessing the full surface in a prompt.
