# Edit category contract

Checked 6 September 2026. This records the shape that
[`connector/extension/src/edit-policy.js`](../../connector/extension/src/edit-policy.js)
publishes for every Edit action, so the Bridge settings page and the
conversational Edit grant can render the same truth.

## Where the categories come from

Every category is either curated or derived.

Curated categories are written by hand. They stay the recommended path: one
narrow change with an exact guard, such as the Canvas Page text repair, the eight
image alternative-text repairs, and the Canvas Assignment due-date change.

A curated category can also name the reads its guard needs, in
`requiresOperations`. When the connected catalog is missing one of them the
category is published as `review` with that stated, instead of being offered and
then refused at the moment a person tries to save it.

Derived categories come from the connector catalog, one per provider write. A
Canvas write is Edit-available only when the shared admission decision in
[`connector/extension/generated/canvas-operation-admission.js`](../../connector/extension/generated/canvas-operation-admission.js)
returns `write.state === "admitted"`. Every held write is published as `review`
with the sentence `canvasAdmissionReason` gives for that exact hold, so the
settings page repeats the same reason the assistant and the service worker use.
The Canvas path predicate exists in one place only.

One admitted Canvas write is published as `review` anyway. `canvas_update_quiz_item`
changes one New Quiz question in place, and New Quizzes matches the parts of a
question by the ids the question already holds, so a change that renumbers them
leaves the old parts behind as blank answers. Section 2.2 of the
[New Quizzes and Item Banks contract](../research/CANVAS-NEW-QUIZZES-ITEM-BANKS-CONTRACT-2026-09-06.md)
records the harvested production evidence for that. A structural change to a
question needs the delete-then-add contract, which Morrow does not offer yet, so
the two curated New Quiz repairs stay the only Edit path to a question. The
connector refuses any renumbering PATCH on its own as well, guarded or not
([`connector/extension/src/new-quiz-item-guard.js`](../../connector/extension/src/new-quiz-item-guard.js)).

## Item Bank writes

The catalog publishes nine Item Bank owner-write shapes as course-bound Edit
categories: bank create, rename, and delete; item create and complete-item
update; item attach and entry removal; one exact course read-share; and one
random bank draw attached to one exact New Quiz. `canvasOperationAdmission`
holds all nine. It holds bank creation because the provider
creates an account-owned bank without a proved recoverable course-association
transaction. It holds the other seven bank-management shapes because Morrow
cannot prove complete downstream reach. It holds the quiz bank draw because no
durable assignment-bound recovery descriptor survives a browser worker or
process interruption. All nine holds occur before provider I/O. A standing Edit
grant cannot override them.

The quiz bank-draw read has a second credential boundary. Morrow opens the exact
selected New Quiz assignment, obtains its assignment-bound builder credential,
derives and verifies the private quiz id, and reads numbered quiz-entry pages
through a required empty end page. A page or row bound stops the read. The
cataloged write shape remains review-only until durable recovery exists.

`morrow_plan_item_bank_question_image_alt_repair` depends on the held
complete-item update. It therefore stops before any bank read or PATCH.
`morrow_read_item_bank_fan_out` remains review context. Its incomplete result is
never an authority grant or a write precondition.

Three enforcement sites apply the Item Bank contract independently:
[`packages/canvas-api-catalog/src/operation-admission.ts`](../../packages/canvas-api-catalog/src/operation-admission.ts)
(the published course target and write hold),
[`connector/extension/src/service-worker.js`](../../connector/extension/src/service-worker.js)
(the exact frame and credential boundary), and
[`packages/canvas-connector-mcp/src/runtime.ts`](../../packages/canvas-connector-mcp/src/runtime.ts)
(the MCP course binding). The page executors own the pre-I/O hold and the read
pagination and secret-sanitization checks.

**Live-unverified surface.** Local tests prove all seven reads and all nine
pre-I/O write holds. No Morrow-connected Canvas tenant has answered these private
routes, so none has live provider proof.

## Published shape

`categoriesForBinding` returns objects with these fields.

| Field | Value |
|---|---|
| `id` | `action:<provider>:<toolName>` for a derived category, or the curated id. |
| `group` | Display group. Destructive Canvas actions use `Canvas actions that remove content`. Moodle writes with a wider effect use `Moodle · Course lifecycle`. |
| `label` | Catalog summary, at most 300 characters. |
| `description` | Catalog description, at most 1,000 characters including any wider-effect or capped-grant sentence below. |
| `availability` | `edit` or `review`. |
| `reviewReason` | Present only with `review`. The exact admission or provider reason, or, for a curated repair, the routes the connected catalog does not carry. |
| `tier` | `standard` or `destructive`, from the catalog risk of the action. Always present. |
| `requiresFieldSelection` | `true` only on a derived category whose grant is capped. Absent otherwise. |

`tier` describes what the action does, not whether it can be granted. A
destructive action that is held for review still carries `tier: "destructive"`.

The bridge protocol carries both new fields
([`packages/bridge-protocol/src/index.ts`](../../packages/bridge-protocol/src/index.ts)).
They are optional there, so an options payload written before this change still
parses.

## Moodle actions with a wider effect

A derived Moodle category is grouped by the noun it changes, such as
`Moodle · Page`. Two kinds of write reach past the one activity they name, so
they are published in `Moodle · Course lifecycle` instead of that per-noun
group, and their description ends with the wider effect in plain words:

- a catalog entry marked `destructive` adds "It removes or replaces saved course
  content for everyone in the course", and ends "and Morrow cannot undo it" when
  the entry is also marked `irreversible`;
- `moodle_hide_course` and `moodle_show_course` add "It changes whether the whole
  course is visible to every enrolled learner, not one activity in it".

They stay `availability: "edit"`. The group and the sentence are what separate
them from a due-date change; only a `destructive` entry also carries
`tier: "destructive"`.

## Identity arguments are never editable fields

The derived field list drops the arguments that name the target rather than
change it: `course_id`, `url_or_id`, `id`, `topic_id`, `module_id`,
`section_id`, `target_section_id`, `assignment_id`, `item_id`, `chapter_id`,
`after_chapter_id`, `category_id`, `grade_item_id`, `slot_id`,
`section_number`, `section_name`, `bank_id`, `bank_entry_id`, `expected_digest`
and the guard arguments, including `morrow_item_bank_guard`. So
a granted Moodle Book chapter edit permits `content` and `title` only, and the
settings page no longer offers `chapter_id` or `category_id` as something Edit
access can change.

The structural list also includes `expected_snapshot`. Snapshot digests are
preconditions, not editable provider fields, so a category never presents them
as something the person can grant. The category still grants only the payload
fields, while the executor independently requires the exact snapshot object.

Two files hold this same list and must agree:
[`connector/extension/src/edit-policy.js`](../../connector/extension/src/edit-policy.js)
and [`packages/bridge-protocol/src/index.ts`](../../packages/bridge-protocol/src/index.ts).
[`packages/mcp-server/src/runtime.ts`](../../packages/mcp-server/src/runtime.ts)
applies the same rule when it derives changed fields for Edit authority.

## Capped grants

A derived category for an operation with more than eight non-structural fields
is published with `requiresFieldSelection: true`, and its rule grants
`allowedChangedFields: []`. Enabling it alone therefore permits no field change;
the service worker refuses the write with `edit_policy_fields_refused`. Its
description states this in plain words:

> This action can change 47 different settings. Morrow does not grant all of
> them at once, so selecting it alone does not let Morrow change any of them.
> Morrow can still prepare this change for your review.

Curated categories are never capped. They already name their exact fields or
carry an exact content guard.

## Counts against the frozen catalog

| Set | Count |
|---|---|
| Canvas categories published for one course | 572 (10 curated, 562 derived) |
| Canvas derived, `availability: "edit"` | 224 |
| Canvas derived, `availability: "review"` | 338 |
| Canvas categories with `tier: "destructive"` | 140, of which 48 are Edit-available |
| Canvas categories with `requiresFieldSelection` | 33 |
| Moodle categories with `requiresFieldSelection` | 2 (`moodle_create_choice`, `moodle_update_choice`) |

Reproduce them with `node --test scripts/test/bridge-settings-contract.test.mjs`
and the enumeration inside that file.

## What the settings page still owes

The rendering of `connector/extension/settings/settings.js` is owned by the
settings lane. Two behaviours are needed there and are not implemented yet:

1. A category with `tier: "destructive"` needs its own explicit confirmation
   before it can be saved. Grouping alone is not consent.
2. A category with `requiresFieldSelection: true` must not read as a normal
   grant. Until Morrow offers a field chooser, the page should present it as
   unavailable to enable, or repeat the description sentence next to the
   control.

The rendered appearance of the new group and of the capped description is
**live-unverified**. It needs an after-screenshot check by the settings lane.

## Effect on saved permissions

`createEditPermission` and `validEditPermission` are unchanged. The scope digest
still covers the exact rules, so a saved permission that granted a now-capped
category no longer validates. The person is returned to Plan and must grant the
narrower access again. This is the intended result of a changed rule set.

The same applies to `action:canvas:canvas_update_quiz_item`. That category is no
longer Edit-available, so `selectedCategories` refuses it and a saved permission
that named it no longer validates. A person who had granted it is returned to
Plan and can grant the two curated New Quiz repairs instead.
