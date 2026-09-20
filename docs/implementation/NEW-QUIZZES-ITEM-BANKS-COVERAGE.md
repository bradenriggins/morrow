# New Quizzes and Item Banks: every user task, and its live proof

This matrix lists every task a person can do with New Quizzes and Item Banks in Canvas, the Canvas route that performs it, the Morrow control that exposes it, and its live proof in the BT2 sandbox course 89585. The task list comes from three sources: the public New Quiz API (`/api/quiz/v1`), Canvas's assignment routes a New Quiz uses, and every quiz-service path the scripts of Canvas's own New Quizzes and Item Banks pages can build (read from the live pages on 2026-09-19).

States: **proven** (verified live through Morrow), **gap** (Canvas supports it and Morrow does not yet prove it), **Canvas refuses** (Canvas itself has no route or refuses it, with evidence).

## Quiz

| Task | Canvas route | Morrow control | State |
|---|---|---|---|
| List quizzes, read one quiz | `GET /quiz/v1/courses/:c/quizzes[/:a]` | `canvas_list_new_quizzes`, `canvas_get_new_quiz` | proven |
| Create a quiz | `POST /quiz/v1/courses/:c/quizzes` | `morrow_plan_new_quiz_create` | proven |
| Delete a quiz | `DELETE /quiz/v1/courses/:c/quizzes/:a` | `morrow_plan_new_quiz_delete` | proven |
| Edit title | `PATCH /quiz/v1/courses/:c/quizzes/:a` | `morrow_plan_new_quiz_settings` / `canvas_update_single_quiz` | proven |
| Edit instructions, points, grading type, assignment group | same | `canvas_update_single_quiz` | proven |
| Edit due, available-from, and until dates | same | `canvas_update_single_quiz` | proven |
| Settings: shuffle answers | same | `morrow_plan_new_quiz_settings` | proven |
| Settings: shuffle questions, time limit, attempts and score to keep, cooling period, one at a time and backtracking, calculator, access code, IP filter, result view (each on and back off) | same | same | proven |
| Publish and unpublish | `PUT /v1/courses/:c/assignments/:a` (`published`) | `canvas_edit_assignment` | proven |
| Duplicate a quiz | `POST /v1/courses/:c/assignments/:a/duplicate` | `canvas_duplicate_assignment` | proven |
| Assign to a section with its own dates; change and remove it | `/v1/courses/:c/assignments/:a/overrides` | override routes | proven |
| Place in a module, move within modules | module item routes | `morrow_plan_new_quiz_module_placement`, `…_module_move` | proven |
| Order within an assignment group | assignment group routes | `morrow_plan_new_quiz_assignment_group_order` | proven |
| Copy a quiz into another course | `POST /v1/courses/:c/content_migrations` (course copy, selective) | content migration routes | gap |
| Import questions from QTI into a quiz | quiz-service `…/quizzes/:q/qti_imports` | none | gap |
| Check a quiz's saved state | reads | `morrow_check_new_quiz` | proven |

## Questions in a quiz

| Task | Canvas route | Morrow control | State |
|---|---|---|---|
| List and read questions | `GET /quiz/v1/…/items[/:i]` | `canvas_list_quiz_items`, `canvas_get_quiz_item` | proven |
| Create each of the 12 question types | `POST /quiz/v1/…/items` | `morrow_plan_new_quiz_item_create` | proven |
| Edit a question's text | `PATCH /quiz/v1/…/items/:i` | `canvas_update_quiz_item` | proven |
| Edit points, answer choices (add and remove), correct answer, feedback, answer feedback, for every type | same | `canvas_update_quiz_item` | proven |
| Change a question's type | delete and create | `morrow_plan_new_quiz_item_replacement` | proven |
| Reorder questions, bank draws, and single bank questions | `PATCH …/items/:i` (`position`) | `morrow_plan_new_quiz_item_order` | proven |
| Delete a question | `DELETE /quiz/v1/…/items/:i` | `morrow_plan_new_quiz_item_delete` | proven |
| Duplicate a question | create with the saved question | `morrow_plan_new_quiz_item_create` | gap |
| Add a question with an uploaded image (Hot Spot) | media upload URL, then create | `morrow_plan_new_quiz_item_create` with `material_path` | proven |
| Repair missing image alt text (body, choice, answer feedback, feedback) | `PATCH …/items/:i` | the four `…_image_alt_repair` planners | proven |
| Accessibility audit of a question or quiz | reads | `morrow_audit_course` | proven |
| Stimulus (passage) with linked questions | quiz-service `…/quiz_entries` | none | gap |
| Align a question to an outcome | quiz-service `/api/alignment_sets` | none | gap |
| Regrade a question | quiz-service `…/quiz_entry_regrades` | none | gap |

## Moderation, results, and reports

| Task | Canvas route | Morrow control | State |
|---|---|---|---|
| Course and quiz accommodations (extra time, extra attempts, reduced choices) | `POST /quiz/v1/…/accommodations` | `morrow_plan_new_quiz_accommodation` | proven (extra time) |
| Student and item analysis reports | `POST /quiz/v1/…/reports` | `morrow_plan_new_quiz_report` | proven |
| Read submissions and scores | `GET /v1/courses/:c/assignments/:a/submissions` | submission reads | gap |
| Grade or comment on a submission | `PUT /v1/…/submissions/:u` | grade routes | gap |
| Moderate a session: reopen, extra time, autosubmit | quiz-service `…/quiz_sessions/:s/reopen`, `/autosubmit` | none | gap |
| Quiz and item statistics | quiz-service `…/stats/quiz_analysis`, `…/stats/item_analyses` | none | gap |

## Item Banks

| Task | Canvas route | Morrow control | State |
|---|---|---|---|
| List, read, create, rename, delete a bank | quiz-service `/api/banks` | `canvas_item_bank_*` | proven |
| Share a bank with a course (read) | `…/banks/:b/shared_banks` | `canvas_item_bank_share_bank` | proven |
| Change a share's permission (read to edit) | `PATCH …/banks/:b/shared_banks/:s` | `canvas_item_bank_update_share` | proven |
| Share with a user or an account; remove a share | same | none | gap |
| Create a question in a bank (choice) | `…/banks/:b/items`, then `…/bank_entries` | `canvas_item_bank_create_item` | proven |
| Create each of the 12 types in a bank | same | same | gap |
| Read and update a bank question | bank entry read; `PATCH …/banks/:b/items/:i` | `canvas_item_bank_get_item`, `…_update_item` | proven |
| Attach a question to another bank; remove an entry | `…/bank_entries` | `…_attach_item`, `…_delete_entry` | proven |
| Copy a question into another bank | `POST …/banks/:b/bank_entries/copy` | `canvas_item_bank_copy_entry` | proven |
| Move a question into another bank | `POST …/banks/:b/bank_entries/move` | `canvas_item_bank_move_entry` | proven |
| Search a bank by text or tag | `GET …/banks/:b/bank_entries/search` | `canvas_item_bank_search_entries` | proven |
| List the tags a bank question can carry | `GET /api/tags` | `canvas_item_bank_list_tags` | proven |
| Tag a question, remove a tag by its value | `…/bank_entries/:e/tag_associations` | `canvas_item_bank_add_entry_tag`, `…_remove_entry_tag` | proven |
| Draw from a bank into a quiz; add one bank question; remove a draw | `…/quizzes/:q/quiz_entries` | `…_attach_bank_to_quiz`, `…_attach_bank_entry_to_quiz`, `…_delete_quiz_bank_entry` | proven |
| Change a draw's question count or points | `PATCH …/quiz_entries/:e` | `canvas_item_bank_update_quiz_draw` | proven |
| Put a question written in a quiz into a bank | `POST …/banks/:b/bank_entries/move_from_quiz_entry` | `canvas_item_bank_add_quiz_question_to_bank` | proven |
| List a quiz's draws | `GET …/quiz_entries` | `canvas_item_bank_list_quiz_draws` | proven |
| Repair missing alt text in a bank question | `PATCH …/banks/:b/items/:i` | `morrow_plan_item_bank_question_image_alt_repair` | proven |
| Bank reach across courses | reads | `morrow_read_item_bank_fan_out` | proven |
| List archived banks | `GET /api/banks/archived` | none | Canvas refuses (403 for this account) |
| Restore an archived bank | `POST /api/banks/:b/restore` | none | gap |
| Import QTI into a bank | `…/banks/:b/qti_imports` | none | gap |
