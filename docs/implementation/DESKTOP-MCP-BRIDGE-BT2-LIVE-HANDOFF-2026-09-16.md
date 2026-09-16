# Canvas operations proven live in BT2, 2026-09-16

## Exact target

- Machine: Braden's MacBook Air (`Bradens-MacBook-Air.local`, arm64).
- Checkout: `/Users/Braden/Projects/.morrow-worktrees/desktop-mcp-bridge-triple-check-20260914`.
- Branch: `codex/desktop-mcp-bridge-triple-check-20260914`, pushed at `ac00b2d7aaca8f7eb64df28d8a52c7fb3c3a1d3f` with exact remote readback.
- Canvas tenant: `https://chcp.instructure.com`. Live course: `BIOL 101: General Biology`, id `89585`.
- Installed build: `output/live-bt2-final-package-v44`, Bridge 1.0.24, paired, course verified. Signed in throughout; Chrome was never restarted.
- Live exclusions without separate exact authority: grades and learner messages.

## What was blocked yesterday and is proven today

Every family below was created, found again by a fresh Canvas read, changed,
deleted, and confirmed absent, with Morrow verifying each step. The four marked
`new` could not be approved at all before this work: their review page had no
Apply control and every approval was refused.

| Family | Create | Change | Delete | Gone |
| --- | --- | --- | --- | --- |
| Page | verified | verified | verified | confirmed |
| Assignment | verified | verified | verified | confirmed |
| Discussion | verified | verified | verified | confirmed |
| Quiz (`new`) | verified | verified | verified | confirmed |
| Module | verified | verified | verified | confirmed |
| Assignment group | verified | verified | verified | confirmed |
| Section (`new`) | verified | verified | verified | confirmed |
| Gradebook column | verified | verified | verified | confirmed |
| Group category | verified | verified | verified | confirmed |
| Calendar event | verified | verified | verified | confirmed |
| Bookmark (`new`) | verified | verified | verified | confirmed |
| Planner note (`new`) | verified | verified | verified | confirmed |

Receipt: `output/live-bt2-final-package-v35/live-proof/lifecycle-receipt.json`.

Files: one material was uploaded to the course folder through the reviewed
transfer and settled `verified` on the first answer, was read back in Canvas by
name, size and folder, and was deleted, verified. Nine earlier proof files were
also deleted through Morrow, each verified. Before this work no Canvas file
change could be sent at all, and no upload could be confirmed.

Site authority: the account course list, account terms, the person's courses,
calendar, conversations, groups, favorite groups and files all read. The course
nickname was set, read back exactly, cleared, and read back as cleared.

## Defects repaired in this delivery

Rows 459 to 464 of `DEFECT-ERADICATION-LEDGER.md`:

- 459: the review page could name ten kinds of Canvas object and withheld Apply
  for every other id, so those changes could never be approved.
- 460: a deletion Canvas answers by still returning the record was never confirmed.
- 461: the catalog's identity changed when Canvas re-served the same specification,
  which failed the catalog gate and would refuse Bridge pairing.
- 462: every Canvas file change was refused before it was sent.
- 463: the reviewed transfer could not prove an upload Canvas had saved.
- 464: an upload Canvas saved but Morrow could not confirm could never be settled,
  and it blocked every later upload in that course.

## The three findings this handoff opened, now closed

Rows 465 to 469 close them, each proven live:

- A change Morrow could not confirm could only be settled by a person, and it held
  its target against every later change. Reconciliation now rebuilds a comparator
  from the contract Morrow has now: all six live records settled themselves, and
  the journal holds 431 operations with none unresolved.
- One refusal code stood for four conditions, so a refused Bridge update said
  nothing useful. Each condition now answers for itself.
- An operation record said a change failed and never said why. It now carries
  Morrow's own attention codes, which hold no course or learner content.
- The person's own Canvas routes refused `self`, the name Canvas uses for them,
  and following Canvas's own paginated answer for such a route was refused as a
  foreign path. Both are repaired; a 128-file listing reads as `self` live.
- Marking every conversation read was sent unchecked although Canvas answers its
  exact postcondition. It is proved now, so 341 admitted writes read back exactly
  and 199 remain Review only.

## Open, with evidence

- 199 admitted writes still have no exact Canvas postcondition. Each is sent only
  after its own approval and says so. `readback.admittedWritesWithoutExactReadback`
  in the generated report lists them. Two reorders (`canvas_reorder_quiz_items`,
  `canvas_reorder_question_groups`) carry ids of mixed kinds in one argument, so a
  listing comparator there would report false mismatches; they stay honest instead.

## Private receipts

Under ignored `output/live-bt2-final-package-v35/live-proof/`. They can contain
course data. Do not stage or publish them.
