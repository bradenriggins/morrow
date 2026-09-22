# Source-linked course revision

Status: implementation in progress. Base: `fc75243155015c35f39e4c37492b352c4fef0d7a`.

## Goal

Turn accepted source-based proposals into one durable lesson-and-question change
across an explicit set of course sections. The educator sees the source passage,
the reason for each change, the preserved settings, and the execution order in
the existing review. One approval starts the work and checks each result.

The AI host supplies proposed corrections after reading the source and courses.
The existing lesson specialists can inform those proposals. Quote validation
proves that the cited text exists. It does not prove an instructional judgment.
The review states this distinction.

## Acceptance

1. One request prepares up to three named course-section pairs from one source.
   Each pair contains one exact page-text correction and one direct New Quiz
   question correction. Every correction cites an exact passage in that source.
2. All current targets and source quotes pass validation before a batch is saved.
   The page uses the existing revision guard. A question uses a fresh complete
   item snapshot and a snapshot of the assignment's protected settings.
3. Only the selected page phrase, question content, and optional saved answer
   change. Page metadata, the remaining question fields, and the assignment's
   title, dates, publication, points, and grouping are checked after the change.
4. The review displays the source quote, rationale, and lesson dependency next to
   the current/proposed content. These details are part of the frozen request.
5. The existing batch journal owns execution. Each question depends on its lesson.
   An unconfirmed lesson prevents the dependent question from being sent.
6. Existing tests and the real connector browser harness prove the approved path
   and refusal of changed source. Live Canvas evidence remains a separate gate.

## Non-goals and unchanged components

No new chat app, database, executor, approval system, or model service. Do not
change legacy Morrow, ExamplePlatform, unrelated LMS features, release settings, or
existing customer content. This slice does not edit shared banks or bank draws,
create questions, change grades, or establish complete course dependency coverage.
Existing bank holds remain in force. A full source-to-course showcase still needs
dependency discovery, saved instructor decisions, live proof, and a recording.

## API evidence

The [official New Quiz Items contract](https://canvas.instructure.com/doc/api/new_quiz_items.html)
permits updates to direct QuestionItem records. Bank entries and bank draws are
read-only through that API. The planner uses the exact item route and refuses
other entry types. Canvas does not provide an atomic edit lock for this flow;
fresh checks detect observed changes and unconfirmed results remain visible.
