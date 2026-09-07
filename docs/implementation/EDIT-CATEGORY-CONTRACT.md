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

## The one Item Bank Edit path

`canvas_item_bank_question_image_alt` is the only curated category that reaches
an existing New Quizzes Item Bank. Its single rule names
`ITEM_BANK PATCH /api/banks/{bank_id}/items/{item_id}`, grants no changed field,
and carries two more rule fields: `requiresItemBankGuard: true` and
`itemBankGuardKind: "item_bank_entry_image_alt"`. `exactRule` carries them into
the saved permission exactly as it carries the Canvas content guard fields, and
`ruleIdentity` separates rules by the Item Bank guard kind as well, so two guard
kinds on the same route can never merge into one rule.

Everything else about an Item Bank stays `review`. `canvasOperationAdmission`
holds all seven Item Bank writes and now gives three separate reasons:

| Write | Held reason |
|---|---|
| `update_item` | `item_bank_fan_out_and_guard_required` |
| `create_bank` | `item_bank_account_scope_not_course_scope` |
| `archive_bank`, `attach_item`, `create_item`, `delete_entry`, `share_bank` | `item_bank_dependency_review_required` |

`create_bank` has its own reason because the in-frame session does prove one
course. What it cannot do is confine the bank: a bank belongs to the Canvas
account, so a bank Morrow creates does not stay inside the selected course.

`archive_bank` can never become Edit-available. Section 3.6 of the
[New Quizzes and Item Banks contract](../research/CANVAS-NEW-QUIZZES-ITEM-BANKS-CONTRACT-2026-09-06.md)
requires an administrator environment flag, a complete dependency preflight, and
fresh counts showing zero bank entries and zero uses before an archive. Morrow
can establish none of those from the routes it has.
`packages/canvas-api-catalog/test/catalog.test.ts` and
`scripts/test/bridge-settings-contract.test.mjs` both assert that hold.

Three enforcement sites let the guarded question repair past the Item Bank hold,
and only that one:
[`packages/canvas-api-catalog/src/operation-admission.ts`](../../packages/canvas-api-catalog/src/operation-admission.ts)
(the reason the settings page and the assistant repeat),
[`connector/extension/src/service-worker.js`](../../connector/extension/src/service-worker.js)
(`guardedItemBankUpdate` from `edit-policy.js`, which also proves the guard names
the selected course) and
[`packages/canvas-connector-mcp/src/runtime.ts`](../../packages/canvas-connector-mcp/src/runtime.ts)
(the same exemption at its own boundary). A call with no accepted guard is
refused at all three.

**Live-unverified, and one open limit.** No Edit grant has been exercised against
a real Item Banks frame. The guard travels as an ordinary
`morrow_item_bank_guard` argument, not as a `_morrow` control:
`splitBridgeCallArguments` in
[`packages/bridge-protocol/src/index.ts`](../../packages/bridge-protocol/src/index.ts)
accepts a fixed set of `_morrow` fields that has no Item Bank entry. So a caller
can compose a guard. That cannot produce a wrong write: the extension refuses a
guard that names another course, and the frame re-reads the exact question and
refuses any guard whose digest does not match before it sends anything. It does
mean the fan-out record inside a composed guard is checked only for internal
consistency at that point.

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

Two files hold this same list and must agree:
[`connector/extension/src/edit-policy.js`](../../connector/extension/src/edit-policy.js)
(the grant and the service-worker check) and
[`packages/bridge-protocol/src/index.ts`](../../packages/bridge-protocol/src/index.ts)
(`matchesBridgeEditPermission`). A name present in only one of them refuses a
granted write or silently returns it to review.
[`packages/mcp-server/src/runtime.ts`](../../packages/mcp-server/src/runtime.ts)
(`browserEditFields`) reaches the same result from a shorter list, because it
also drops every path parameter named in the operation key. It does not yet know
the Item Bank guard, so a plan that carries `morrow_item_bank_guard` as an
ordinary argument is returned for review there rather than authorized.
`morrow_plan_item_bank_question_image_alt_repair`
([`packages/mcp-server/src/item-bank-repair.ts`](../../packages/mcp-server/src/item-bank-repair.ts))
now produces that plan, so the Item Bank category can be granted and the
connector will accept the guarded call. Every such plan still asks a person to
approve it. To close that, `browserEditFields` must drop the guard name and the
same function must require `requiresItemBankGuard` to match a guard that is
present and valid. Dropping the name alone would authorize an unguarded question
update at that boundary.

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
