# Morrow for Muse: Operation Catalog (authoritative)

Date: 2026-09-20. Product: Morrow for Muse (Canvas connector and separate Moodle session lane, no MCP).
Package note (0.4.3): Moodle runtime and agent instructions ship in the release. Moodle claims remain limited to the live-proven rows and lane-level evidence below; catalog status is provider-specific.
This file is the authoritative operation catalog for the proof battery. It supersedes the older proof ledger (proof-battery/LEDGER.md), which the source repository keeps as-is for history; it is not in the release.

Path convention: the desktop catalog records paths without the /api prefix; every Canvas REST path below is shown with the real /api prefix added.

## Proof standard
Each operation needs: (1) a batch rendered by transport/batch.py or the equivalent product transport, (2) live dispatch through the educator's browser-owned authenticated session, (3) readback verification, (4) full cleanup of disposable test objects, (5) a sanitized evidence fixture. Statuses: live-proven, pending, evidence-hold, unsupported, excluded, source-only, failed. failed means a disposable live battery attempted the operation and it did not succeed; the failure evidence is recorded in the notes and the op is not retried without a code or request-shape change. Amendment 2026-09-21: tenant-restricted is RETIRED per parity law. Nothing is gated by tenant: no tenant is ever allowlisted, restricted, or treated differently from any other. evidence-hold means the operation is not yet live-proven through Morrow for Muse and is refused on EVERY tenant until a disposable live battery proves the complete path; when proven it is admitted on ALL tenants. Learner-data is an orthogonal flag: flagged ops are NOT live-tested until the learner tokenization boundary lands.

## Evidence citations: what is in this tree and what is not
Citations in row notes name where the evidence was recorded, not
always a file in this tree. In the source repository, evidence lives
under `proof-battery/evidence/`, `proof-battery/waves/`, and
`proof-battery/live-product-proof/`, and row notes also cite
`DEPLOY.md` (the 2026-09-20 deployment record) and `LEDGER.md` (the
older proof ledger). The release does not carry any of them. The
following are external
evidence history from the operator's 2026-09-20/21 proof campaign;
they do not exist in this tree and are not carried into the package:
`proofs/quiz-lane/battery2.py`, `proofs/dress-rehearsal/stage4_driver.py`,
`proofs/quiz-lane-unblock.md`, `proofs/moodle-lane-proof.md`,
`item_bank_battery_results.json`, and the 2026-09-21 Chromium write
battery, which lives at `~/workspace/write-battery/` on the operator's
machine (its `MATRIX.md` and chunk files are outside this tree by
design; they are cited by path, not copied in). Treat these citations
as provenance records: what happened, where, and with what objects.
Do not go looking for these files in the tree.

## Transport mechanisms
- canvas-batch: transport/batch.py browser-task transport. Mechanism proven live 2026-09-20 (assignment lifecycle 4045368, course read, users/self). Per-operation proof still required. Integrated behind dispatch/executor.py as the default --backend chromium lane (transport/local_chromium.py over CDP on 127.0.0.1:19223); canvas-batch remains the proof-battery reference transport.
- quiz-api-token: provision/provision.py LTI chain plus dispatch/executor.py. Proven for the banks.build scope (bank lifecycle 4040/4041/4037).
- moodle-ajax: moodle/session.py AJAX envelope (lib/ajax/service.php). Proven for allowed_from_ajax functions. The Moodle code ships as a separate session lane; use its site-level capability probe and do not infer capability from the Canvas catalog.
- moodle-form: moodle/session.py form-path fallback. Proven for forum discussion create/delete.
- executor-plain: dispatch/executor.py plain HTTPS. Works with PAT; session-cookie replay is OTP-walled on the CHCP tenant class, so no-PAT proof goes through canvas-batch.

## Audit corrections vs LEDGER.md
The older proof ledger is in the source repository only, not in the release.

1. C-R2 (list assignments) was marked PROVEN on 'lifecycle readbacks'. Audit found no explicit list-assignments receipt, only single-assignment GETs. Corrected to pending.
2. NQ-R1/NQ-R2 (list/get New Quiz) were marked PROVEN on 'provisioning battery'. The battery2 proof used quiz-api host paths (/api/quizzes/{id}), not the /api/quiz/v1 Canvas paths. The /api/quiz/v1 ops are corrected to pending; the quiz-api host read/edit are recorded in the New Quiz sequence table.
3. NQ-W1 was marked PROVEN. SUPERSEDED 2026-09-20 by the full New Quiz lifecycle (quiz 4045369): quiz-API DELETE returns HTTP 200 and cleans both quiz and assignment, no orphan. The old 401/orphan-506477 reading was wrong; that orphan came from deleting assignment 4045366 through the Canvas assignment endpoint first. Correct lifecycle: always delete a New Quiz through the quiz API. Orphan 506477 itself remains Braden's call.
4. IB-W2 was marked PENDING with 'entry 82698 archived with bank'. SUPERSEDED 2026-09-20: item create (11242724/11242727/11242728/11242729, HTTP 201) and item update (PATCH 200) are proven; entry attach (82698, 82695, 82699, 82700, 82701, 82702) and entry delete (204, idempotent) are proven; entry GET is the working item read path. Direct item GET is provider-anomalous (404 on existing items) and no item DELETE route exists (all 404).
5. IB-W3 (share/unshare) was marked NOT PROVEN (delta-2 blocker). SUPERSEDED 2026-09-20: sharing is proven (shares 38922/38924, HTTP 201; list 200). SUPERSEDED 2026-09-21: unshare is proven via PATCH /api/banks/{bank}/shared_banks/{id} with {shared_bank:{permission:"removed_access"}} (share 38934, PATCH 200, list verified clean; 2026-09-21 Chromium write battery). DELETE on the share route 404s; that DELETE reading is retired as the unshare statement.
6. M-R1/M-R2/M-R3 were marked PROVEN. Refined: the successful run created discussion 2 / post 2 (not discussion 1 / post 1, which was the failed first run, cleaned up in the second run). The AJAX variants of the forum functions are unsupported on stock Moodle 5.2, not pending.
7. C-R11/C-R12 were correctly pending with the tokenization gate. Kept.

## Canvas course-level operations

### ai_conversations (9)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-1 | canvas_create_ai_conversation | POST | /api/v1/courses/{course_id}/ai_experiences/{ai_experience_id}/conversations | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-2 | canvas_create_feedback_on_conversation_message | POST | /api/v1/courses/{course_id}/ai_experiences/{ai_experience_id}/conversations/{id}/messages/{message_id}/feedback | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-3 | canvas_delete_ai_conversation | DELETE | /api/v1/courses/{course_id}/ai_experiences/{ai_experience_id}/conversations/{id} | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-4 | canvas_delete_feedback_on_conversation_message | DELETE | /api/v1/courses/{course_id}/ai_experiences/{ai_experience_id}/conversations/{id}/messages/{message_id}/feedback/{feedback_id} | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-5 | canvas_generate_conversation_evaluation | POST | /api/v1/courses/{course_id}/ai_experiences/{ai_experience_id}/conversations/{id}/evaluation | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-6 | canvas_get_active_conversation | GET | /api/v1/courses/{course_id}/ai_experiences/{ai_experience_id}/conversations | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-7 | canvas_get_conversation_evaluation | GET | /api/v1/courses/{course_id}/ai_experiences/{ai_experience_id}/conversations/{id}/evaluation | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-8 | canvas_post_message_to_conversation | POST | /api/v1/courses/{course_id}/ai_experiences/{ai_experience_id}/conversations/{id}/messages | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-9 | canvas_show_conversation | GET | /api/v1/courses/{course_id}/ai_experiences/{ai_experience_id}/conversations/{id} | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### ai_experiences (9)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-10 | canvas_create_ai_experience | POST | /api/v1/courses/{course_id}/ai_experiences | W | canvas-batch | unsupported | 2026-09-21 Chromium write battery: POST 404 AI experiences unavailable. Provider does not serve this route; moved to unsupported. |
| C-11 | canvas_delete_ai_experience | DELETE | /api/v1/courses/{course_id}/ai_experiences/{id} | W | canvas-batch | unsupported | 2026-09-21 Chromium write battery: No anchor (create 404). Provider does not serve this route; moved to unsupported. |
| C-12 | canvas_list_ai_experiences | GET | /api/v1/courses/{course_id}/ai_experiences | R | canvas-batch | pending |  |
| C-13 | canvas_list_student_ai_conversations | GET | /api/v1/courses/{course_id}/ai_experiences/{id}/ai_conversations | R | canvas-batch | pending |  |
| C-14 | canvas_show_ai_experience | GET | /api/v1/courses/{course_id}/ai_experiences/{id} | R | canvas-batch | pending |  |
| C-15 | canvas_show_edit_ai_experience_form | GET | /api/v1/courses/{course_id}/ai_experiences/{id}/edit | R | canvas-batch | pending |  |
| C-16 | canvas_show_new_ai_experience_form | GET | /api/v1/courses/{course_id}/ai_experiences/new | R | canvas-batch | pending |  |
| C-17 | canvas_show_student_ai_conversation | GET | /api/v1/courses/{course_id}/ai_experiences/{id}/ai_conversations/{conversation_id} | R | canvas-batch | pending |  |
| C-18 | canvas_update_ai_experience | PUT | /api/v1/courses/{course_id}/ai_experiences/{id} | W | canvas-batch | unsupported | 2026-09-21 Chromium write battery: No anchor (create 404). Provider does not serve this route; moved to unsupported. |

### analytics (6)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-19 | canvas_get_course_level_assignment_data | GET | /api/v1/courses/{course_id}/analytics/assignments | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-20 | canvas_get_course_level_participation_data | GET | /api/v1/courses/{course_id}/analytics/activity | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-21 | canvas_get_course_level_student_summary_data | GET | /api/v1/courses/{course_id}/analytics/student_summaries | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-22 | canvas_get_user_in_a_course_level_assignment_data | GET | /api/v1/courses/{course_id}/analytics/users/{student_id}/assignments | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-23 | canvas_get_user_in_a_course_level_messaging_data | GET | /api/v1/courses/{course_id}/analytics/users/{student_id}/communication | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-24 | canvas_get_user_in_a_course_level_participation_data | GET | /api/v1/courses/{course_id}/analytics/users/{student_id}/activity | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### announcement_external_feeds (3)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-25 | canvas_create_external_feed_courses | POST | /api/v1/courses/{course_id}/external_feeds | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 200 feed id 186. |
| C-26 | canvas_delete_external_feed_courses | DELETE | /api/v1/courses/{course_id}/external_feeds/{external_feed_id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: DELETE 200. |
| C-27 | canvas_list_external_feeds_courses | GET | /api/v1/courses/{course_id}/external_feeds | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[3]. |

### assignment_extensions (1)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-28 | canvas_set_extensions_for_student_assignment_submissions | POST | /api/v1/courses/{course_id}/assignments/{assignment_id}/extensions | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### assignment_groups (5)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-29 | canvas_create_assignment_group | POST | /api/v1/courses/{course_id}/assignment_groups | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 200 id 436895. |
| C-30 | canvas_destroy_assignment_group | DELETE | /api/v1/courses/{course_id}/assignment_groups/{assignment_group_id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: DELETE 200; terminal GET 404. |
| C-31 | canvas_edit_assignment_group | PUT | /api/v1/courses/{course_id}/assignment_groups/{assignment_group_id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PUT 200. |
| C-32 | canvas_get_assignment_group | GET | /api/v1/courses/{course_id}/assignment_groups/{assignment_group_id} | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: id,name,position,group_weight,sis_source_id,integration_data,rules. |
| C-33 | canvas_list_assignment_groups | GET | /api/v1/courses/{course_id}/assignment_groups | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[10]. |

### assignments (18)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-34 | canvas_batch_create_overrides_in_course | POST | /api/v1/courses/{course_id}/assignments/overrides | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 200 batch override id 82765. |
| C-35 | canvas_batch_retrieve_overrides_in_course | GET | /api/v1/courses/{course_id}/assignments/overrides | R | canvas-batch | pending |  |
| C-36 | canvas_batch_update_overrides_in_course | PUT | /api/v1/courses/{course_id}/assignments/overrides | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PUT 200 id 82766 (retry with assignment_id; first 400 without it). |
| C-37 | canvas_bulk_update_assignment_dates | PUT | /api/v1/courses/{course_id}/assignments/bulk_update | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PUT 200 (bare array body; object wrapper 400s). |
| C-38 | canvas_create_assignment | POST | /api/v1/courses/{course_id}/assignments | W | canvas-batch | live-proven | transport/batchA.json op-create: assignment 4045368 HTTP 201 (2026-09-20 18:30 UTC); proofs/quiz-lane-unblock.md: external_tool variant 4045366 HTTP 201 2026-09-21 Chromium write battery: POST 201 id 4045385; readback 200 name matched. |
| C-39 | canvas_create_assignment_override | POST | /api/v1/courses/{course_id}/assignments/{assignment_id}/overrides | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 201 override id 82764. |
| C-40 | canvas_delete_assignment | DELETE | /api/v1/courses/{course_id}/assignments/{id} | W | canvas-batch | live-proven | transport/batchB.json op-delete: assignment 4045368 workflow_state deleted; proofs/quiz-lane-unblock.md: assignment 4045366 deleted, GET returned 404 2026-09-21 Chromium write battery: DELETE 200; terminal GET 404. |
| C-41 | canvas_delete_assignment_override | DELETE | /api/v1/courses/{course_id}/assignments/{assignment_id}/overrides/{id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: DELETE 200; terminal GET 404. |
| C-42 | canvas_duplicate_assignment | POST | /api/v1/courses/{course_id}/assignments/{assignment_id}/duplicate | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 200 duplicate id 4045386. |
| C-43 | canvas_edit_assignment | PUT | /api/v1/courses/{course_id}/assignments/{id} | W | canvas-batch | live-proven | transport/batchB.json op-rename: assignment 4045368 renamed HTTP 200 (2026-09-20) 2026-09-21 Chromium write battery: PUT 200; readback 200 title matched. |
| C-44 | canvas_get_single_assignment | GET | /api/v1/courses/{course_id}/assignments/{id} | R | canvas-batch | live-proven | 4045368 readback after create; GET after delete returned 404 (weasel-b1-runtime-browser.md section 8; transport/batchB.json op-verify-gone) |
| C-45 | canvas_get_single_assignment_override | GET | /api/v1/courses/{course_id}/assignments/{assignment_id}/overrides/{id} | R | canvas-batch | pending |  |
| C-46 | canvas_list_assignment_overrides | GET | /api/v1/courses/{course_id}/assignments/{assignment_id}/overrides | R | canvas-batch | pending |  |
| C-47 | canvas_list_assignments_assignment_groups | GET | /api/v1/courses/{course_id}/assignment_groups/{assignment_group_id}/assignments | R | canvas-batch | pending |  |
| C-48 | canvas_list_assignments_assignments | GET | /api/v1/courses/{course_id}/assignments | R | canvas-batch | live-proven | LEDGER.md marked this PROVEN on 'lifecycle readbacks'; audit found no explicit list-assignments receipt, only single-assignment GETs. Corrected to pending. 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[10]. |
| C-49 | canvas_list_assignments_for_user | GET | /api/v1/users/{user_id}/courses/{course_id}/assignments | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[10]. |
| C-50 | canvas_list_group_members_for_student_on_assignment | GET | /api/v1/courses/{course_id}/assignments/{assignment_id}/users/{user_id}/group_members | R | canvas-batch | pending |  |
| C-51 | canvas_update_assignment_override | PUT | /api/v1/courses/{course_id}/assignments/{assignment_id}/overrides/{id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PUT 200. |

### blackout_dates (7)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-52 | canvas_create_blackout_date_courses | POST | /api/v1/courses/{course_id}/blackout_dates | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 201 id 9 (start_date/end_date params). |
| C-53 | canvas_delete_blackout_date_courses | DELETE | /api/v1/courses/{course_id}/blackout_dates/{id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: DELETE 204; list verify absent. |
| C-54 | canvas_get_single_blackout_date_courses | GET | /api/v1/courses/{course_id}/blackout_dates/{id} | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: blackout_date. |
| C-55 | canvas_list_blackout_dates_courses | GET | /api/v1/courses/{course_id}/blackout_dates | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[3]. |
| C-56 | canvas_new_blackout_date_courses | GET | /api/v1/courses/{course_id}/blackout_dates/new | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: blackout_date. |
| C-57 | canvas_update_blackout_date_courses | PUT | /api/v1/courses/{course_id}/blackout_dates/{id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PUT 200; readback title_match. |
| C-58 | canvas_update_list_of_blackout_dates | PUT | /api/v1/courses/{course_id}/blackout_dates | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PUT 200 empty blackout list (unbaselined; disclosed). |

### blockeditortemplate (1)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-59 | canvas_list_block_templates | GET | /api/v1/courses/{course_id}/block_editor_templates | R | canvas-batch | pending |  |

### blueprint_courses (13)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-60 | canvas_begin_migration_to_push_to_associated_courses | POST | /api/v1/courses/{course_id}/blueprint_templates/{template_id}/migrations | W | canvas-batch | excluded | Braden exclusion: blueprint migrations push to associated courses, affecting the subaccount beyond the test course |
| C-61 | canvas_get_associated_course_information | GET | /api/v1/courses/{course_id}/blueprint_templates/{template_id}/associated_courses | R | canvas-batch | pending |  |
| C-62 | canvas_get_blueprint_information | GET | /api/v1/courses/{course_id}/blueprint_templates/{template_id} | R | canvas-batch | pending |  |
| C-63 | canvas_get_import_details | GET | /api/v1/courses/{course_id}/blueprint_subscriptions/{subscription_id}/migrations/{id}/details | R | canvas-batch | pending |  |
| C-64 | canvas_get_migration_details | GET | /api/v1/courses/{course_id}/blueprint_templates/{template_id}/migrations/{id}/details | R | canvas-batch | pending |  |
| C-65 | canvas_get_unsynced_changes | GET | /api/v1/courses/{course_id}/blueprint_templates/{template_id}/unsynced_changes | R | canvas-batch | pending |  |
| C-66 | canvas_list_blueprint_imports | GET | /api/v1/courses/{course_id}/blueprint_subscriptions/{subscription_id}/migrations | R | canvas-batch | pending |  |
| C-67 | canvas_list_blueprint_migrations | GET | /api/v1/courses/{course_id}/blueprint_templates/{template_id}/migrations | R | canvas-batch | pending |  |
| C-68 | canvas_list_blueprint_subscriptions | GET | /api/v1/courses/{course_id}/blueprint_subscriptions | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[0]. |
| C-69 | canvas_set_or_remove_restrictions_on_blueprint_course_object | PUT | /api/v1/courses/{course_id}/blueprint_templates/{template_id}/restrict_item | W | canvas-batch | excluded | Braden exclusion: blueprint migrations push to associated courses, affecting the subaccount beyond the test course |
| C-70 | canvas_show_blueprint_import | GET | /api/v1/courses/{course_id}/blueprint_subscriptions/{subscription_id}/migrations/{id} | R | canvas-batch | pending |  |
| C-71 | canvas_show_blueprint_migration | GET | /api/v1/courses/{course_id}/blueprint_templates/{template_id}/migrations/{id} | R | canvas-batch | pending |  |
| C-72 | canvas_update_associated_courses | PUT | /api/v1/courses/{course_id}/blueprint_templates/{template_id}/update_associations | W | canvas-batch | excluded | Braden exclusion: blueprint migrations push to associated courses, affecting the subaccount beyond the test course |

### brand_configs (1)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-73 | canvas_get_brand_config_variables_for_sub_account_or_course_courses | GET | /api/v1/courses/{course_id}/brand_variables | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: VERIFIED via browser navigation (302 to CloudFront-hosted variables JSON (ic-brand-primary-*, etc.)); endpoint live with real data. |

### calendar_events (3)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-74 | canvas_create_or_update_events_directly_for_course_timetable | POST | /api/v1/courses/{course_id}/calendar_events/timetable_events | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 200 empty event list (unbaselined; disclosed). |
| C-75 | canvas_get_course_timetable | GET | /api/v1/courses/{course_id}/calendar_events/timetable | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: . |
| C-76 | canvas_set_course_timetable | POST | /api/v1/courses/{course_id}/calendar_events/timetable | W | canvas-batch | unsupported | 2026-09-21 Chromium write battery: POST 500 genuine x2. Provider does not serve this route; moved to unsupported. |

### collaborations (2)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-77 | canvas_list_collaborations_courses | GET | /api/v1/courses/{course_id}/collaborations | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[0]. |
| C-78 | canvas_list_potential_members_courses | GET | /api/v1/courses/{course_id}/potential_collaborators | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[3]. |

### conferences (1)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-79 | canvas_list_conferences_courses | GET | /api/v1/courses/{course_id}/conferences | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: conferences. |

### content_exports (3)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-80 | canvas_export_content_courses | POST | /api/v1/courses/{course_id}/content_exports | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 200 export id 197976. |
| C-81 | canvas_list_content_exports_courses | GET | /api/v1/courses/{course_id}/content_exports | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[10]. |
| C-82 | canvas_show_content_export_courses | GET | /api/v1/courses/{course_id}/content_exports/{id} | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: id,user_id,created_at,workflow_state,export_type,course_id,attachment,progress_url. |

### content_migrations (10)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-83 | canvas_create_content_migration_courses | POST | /api/v1/courses/{course_id}/content_migrations | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 200 migration id 232833 (completed). |
| C-84 | canvas_get_asset_id_mapping | GET | /api/v1/courses/{course_id}/content_migrations/{id}/asset_id_mapping | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: assignments,announcements,verifiers,files,module_items,modules,discussion_topics,quizzes,pages. |
| C-85 | canvas_get_content_migration_courses | GET | /api/v1/courses/{course_id}/content_migrations/{id} | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: id,user_id,workflow_state,started_at,finished_at,migration_type,created_at,migration_issues_url,migration_issues_count,settings. |
| C-86 | canvas_get_migration_issue_courses | GET | /api/v1/courses/{course_id}/content_migrations/{content_migration_id}/migration_issues/{id} | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: id,description,workflow_state,fix_issue_html_url,issue_type,created_at,updated_at,content_migration_url. |
| C-87 | canvas_list_content_migrations_courses | GET | /api/v1/courses/{course_id}/content_migrations | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[7]. |
| C-88 | canvas_list_items_for_selective_import_courses | GET | /api/v1/courses/{course_id}/content_migrations/{id}/selective_data | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[14]. |
| C-89 | canvas_list_migration_issues_courses | GET | /api/v1/courses/{course_id}/content_migrations/{content_migration_id}/migration_issues | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[10]. |
| C-90 | canvas_list_migration_systems_courses | GET | /api/v1/courses/{course_id}/content_migrations/migrators | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[9]. |
| C-91 | canvas_update_content_migration_courses | PUT | /api/v1/courses/{course_id}/content_migrations/{id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PUT 200. |
| C-92 | canvas_update_migration_issue_courses | PUT | /api/v1/courses/{course_id}/content_migrations/{content_migration_id}/migration_issues/{id} | W | canvas-batch | pending |  |

### content_security_policy_settings (2)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-93 | canvas_enable_disable_or_clear_explicit_csp_setting_courses | PUT | /api/v1/courses/{course_id}/csp_settings | W | canvas-batch | excluded | Braden exclusion: CSP settings affect account security posture |
| C-94 | canvas_get_current_settings_for_account_or_course_courses | GET | /api/v1/courses/{course_id}/csp_settings | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: enabled,inherited,settings_locked. |

### course_audit_log (1)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-95 | canvas_query_by_course_audit_course_courses_course_id_get | GET | /api/v1/audit/course/courses/{course_id} | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### course_pace (4)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-96 | canvas_create_course_pace | POST | /api/v1/courses/{course_id}/course_pacing | W | canvas-batch | unsupported | 2026-09-21 Chromium write battery: POST 404 not_found (route absent). Provider does not serve this route; moved to unsupported. |
| C-97 | canvas_delete_course_pace | DELETE | /api/v1/courses/{course_id}/course_pacing/{id} | W | canvas-batch | unsupported | 2026-09-21 Chromium write battery: No anchor (create 404). Provider does not serve this route; moved to unsupported. |
| C-98 | canvas_show_course_pace | GET | /api/v1/courses/{course_id}/course_pacing/{id} | R | canvas-batch | pending |  |
| C-99 | canvas_update_course_pace | PUT | /api/v1/courses/{course_id}/course_pacing/{id} | W | canvas-batch | unsupported | 2026-09-21 Chromium write battery: No anchor (create 404). Provider does not serve this route; moved to unsupported. |

### course_quiz_extensions (1)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-100 | canvas_set_extensions_for_student_quiz_submissions_v1_courses_course_id_quiz_extensions_post | POST | /api/v1/courses/{course_id}/quiz_extensions | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### course_reports (3)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-101 | canvas_start_report_courses_course_id_reports_report_type_post | POST | /api/v1/courses/{course_id}/reports/{report_type} | W | canvas-batch | unsupported | 2026-09-21 Chromium write battery: GET /reports 404; course reports unavailable. Provider does not serve this route; moved to unsupported. |
| C-102 | canvas_status_of_last_report | GET | /api/v1/courses/{course_id}/reports/{report_type} | R | canvas-batch | pending |  |
| C-103 | canvas_status_of_report_course_id_reports_report_type_id_get | GET | /api/v1/courses/{course_id}/reports/{report_type}/{id} | R | canvas-batch | pending |  |

### courses (28)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-104 | canvas_copy_course_content | POST | /api/v1/courses/{course_id}/course_copy | W | canvas-batch | pending | 2026-09-21 Chromium write battery: POST 404 on a bogus source. A 404 proves the route is validating, not that a copy succeeds; no real copy was attempted (not disposable). Marked pending until a disposable live copy proves the path. |
| C-105 | canvas_course_activity_stream | GET | /api/v1/courses/{course_id}/activity_stream | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[21]. |
| C-106 | canvas_course_activity_stream_summary | GET | /api/v1/courses/{course_id}/activity_stream/summary | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[3]. |
| C-107 | canvas_course_todo_items | GET | /api/v1/courses/{course_id}/todo | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[0]. |
| C-108 | canvas_delete_conclude_course | DELETE | /api/v1/courses/{id} | W | canvas-batch | evidence-hold | Destructive on the live course; no disposable test object possible. Not safely provable on a real course. Held 2026-09-21: destructive whole-course op, not safely provable on a real course; refused on every tenant until a safe proof path exists. |
| C-109 | canvas_get_bulk_user_progress | GET | /api/v1/courses/{course_id}/bulk_user_progress | R | canvas-batch | pending |  |
| C-110 | canvas_get_course_copy_status | GET | /api/v1/courses/{course_id}/course_copy/{id} | R | canvas-batch | pending |  |
| C-111 | canvas_get_course_settings | GET | /api/v1/courses/{course_id}/settings | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: allow_final_grade_override,allow_student_discussion_topics,allow_student_forum_attachments,allow_student_discussion_editing,allow_student_discussion_reporting,allow_student_anonymous_discussion_topics,use_default_discussion_settings,default_discussion_settings,filter_speed_grader_by_student_group,grading_standard_enabled. |
| C-112 | canvas_get_effective_due_dates | GET | /api/v1/courses/{course_id}/effective_due_dates | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: 3636219,3636220,3636221,3636222,3636223,3636224,3636225,3636226,3636227,3636228. |
| C-113 | canvas_get_single_course_accounts | GET | /api/v1/accounts/{account_id}/courses/{id} | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: id,name,course_code,account_id,created_at,start_at,default_view,enrollment_term_id,is_public,grading_standard_id. |
| C-114 | canvas_get_single_course_courses | GET | /api/v1/courses/{id} | R | canvas-batch | live-proven | transport/batchA.json op-course: GET /api/v1/courses/89585 (2026-09-20); logs/keepalive-canvas.log status=200 principal 28206 |
| C-115 | canvas_get_single_user | GET | /api/v1/courses/{course_id}/users/{id} | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: id,name,created_at,sortable_name,short_name,sis_user_id,integration_id,sis_import_id. |
| C-116 | canvas_get_user_progress | GET | /api/v1/courses/{course_id}/users/{user_id}/progress | R | canvas-batch | pending |  |
| C-117 | canvas_list_recently_logged_in_students | GET | /api/v1/courses/{course_id}/recent_students | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[1]. |
| C-118 | canvas_list_students | GET | /api/v1/courses/{course_id}/students | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[2]. |
| C-119 | canvas_list_users_in_course_search_users | GET | /api/v1/courses/{course_id}/search_users | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[2]. |
| C-120 | canvas_list_users_in_course_users | GET | /api/v1/courses/{course_id}/users | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[2]. |
| C-121 | canvas_permissions_v1_courses_course_id_permissions_get | GET | /api/v1/courses/{course_id}/permissions | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: read,read_outcomes,read_syllabus,read_files,view_analytics,manage_canvasnet_courses,provision_catalog,manage_demos,manage_sftp_user_settings,ruby_profile. |
| C-122 | canvas_preview_processed_html_v1_courses_course_id_preview_html_post | POST | /api/v1/courses/{course_id}/preview_html | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 200 preview HTML. |
| C-123 | canvas_remove_quiz_migration_alert | POST | /api/v1/courses/{id}/dismiss_migration_limitation_message | W | canvas-batch | unsupported | 2026-09-21 Chromium write battery: POST 404: Quiz migration alert not found. Provider does not serve this route; moved to unsupported. |
| C-124 | canvas_reset_course | POST | /api/v1/courses/{course_id}/reset_content | W | canvas-batch | pending |  |
| C-125 | canvas_restore_course_syllabus_version | POST | /api/v1/courses/{course_id}/restore/{version_id} | W | canvas-batch | pending |  |
| C-126 | canvas_return_test_student_for_course | GET | /api/v1/courses/{course_id}/student_view_student | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: id,name,created_at,sortable_name,short_name,sis_user_id,integration_id,sis_import_id. |
| C-127 | canvas_search_for_content_share_users | GET | /api/v1/courses/{course_id}/content_share_users | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[3]. |
| C-128 | canvas_update_course | PUT | /api/v1/courses/{id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PUT 200 rename; readback name_match; restored 200. |
| C-129 | canvas_update_course_settings | PUT | /api/v1/courses/{course_id}/settings | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PUT 200 setting toggle; restored 200. |
| C-130 | canvas_upload_file_v1_courses_course_id_files_post | POST | /api/v1/courses/{course_id}/files | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: Two-step upload: init 200, finalize 201, id 14127840. |
| C-437 | canvas_list_courses | GET | /api/v1/courses | R | canvas-batch | live-proven | Added 2026-09-22 (first-run audit, lane 5): the educator's first-hour read ("Show me my courses") had no dispatchable catalog row. LIVE-PROVEN through the helper Chromium (in-page fetch via CDP, the same lane the product's Chromium reads use): GET /api/v1/courses?per_page=100 returned HTTP 200 with 97 course records on the live educator session (principal id 28206 pinned, readback name Braden Riggins). Read-only; no objects created, no cleanup needed. |

### custom_gradebook_columns (8)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-131 | canvas_bulk_update_column_data | PUT | /api/v1/courses/{course_id}/custom_gradebook_column_data | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-132 | canvas_create_custom_gradebook_column | POST | /api/v1/courses/{course_id}/custom_gradebook_columns | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-133 | canvas_delete_custom_gradebook_column | DELETE | /api/v1/courses/{course_id}/custom_gradebook_columns/{id} | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-134 | canvas_list_custom_gradebook_columns | GET | /api/v1/courses/{course_id}/custom_gradebook_columns | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-135 | canvas_list_entries_for_column | GET | /api/v1/courses/{course_id}/custom_gradebook_columns/{id}/data | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-136 | canvas_reorder_custom_columns | POST | /api/v1/courses/{course_id}/custom_gradebook_columns/reorder | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-137 | canvas_update_column_data | PUT | /api/v1/courses/{course_id}/custom_gradebook_columns/{id}/data/{user_id} | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-138 | canvas_update_custom_gradebook_column | PUT | /api/v1/courses/{course_id}/custom_gradebook_columns/{id} | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### discussion_topics (29)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-139 | canvas_create_new_discussion_topic_courses | POST | /api/v1/courses/{course_id}/discussion_topics | W | canvas-batch | live-proven [LEARNER-DATA] | Plain topic lifecycle proven 2026-09-20: discussion 1241942 created HTTP 201, read 200 with exact title/body (author 28206); announcement variants remain EXCLUDED (posting an announcement notifies enrolled users, which Braden excluded). Fixture: evidence/canvas-wave-c1/discussion-lifecycle-result.json |
| C-140 | canvas_delete_entry_courses | DELETE | /api/v1/courses/{course_id}/discussion_topics/{topic_id}/entries/{id} | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-141 | canvas_delete_topic_courses | DELETE | /api/v1/courses/{course_id}/discussion_topics/{topic_id} | W | canvas-batch | live-proven [LEARNER-DATA] | Discussion 1241942 deleted HTTP 200, final GET 404, nothing remains (2026-09-20, canvas-batch form lane) |
| C-142 | canvas_disable_summary_courses | PUT | /api/v1/courses/{course_id}/discussion_topics/{topic_id}/summaries/disable | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-143 | canvas_duplicate_discussion_topic_courses | POST | /api/v1/courses/{course_id}/discussion_topics/{topic_id}/duplicate | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-144 | canvas_find_last_summary_courses | GET | /api/v1/courses/{course_id}/discussion_topics/{topic_id}/summaries | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-145 | canvas_find_or_create_summary_courses | POST | /api/v1/courses/{course_id}/discussion_topics/{topic_id}/summaries | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-146 | canvas_get_full_topic_courses | GET | /api/v1/courses/{course_id}/discussion_topics/{topic_id}/view | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-147 | canvas_get_single_topic_courses | GET | /api/v1/courses/{course_id}/discussion_topics/{topic_id} | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-148 | canvas_list_discussion_topics_courses | GET | /api/v1/courses/{course_id}/discussion_topics | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-149 | canvas_list_entries_courses | GET | /api/v1/courses/{course_id}/discussion_topics/{topic_id}/entry_list | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-150 | canvas_list_entry_replies_courses | GET | /api/v1/courses/{course_id}/discussion_topics/{topic_id}/entries/{entry_id}/replies | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-151 | canvas_list_topic_entries_courses | GET | /api/v1/courses/{course_id}/discussion_topics/{topic_id}/entries | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-152 | canvas_mark_all_entries_as_read_courses | PUT | /api/v1/courses/{course_id}/discussion_topics/{topic_id}/read_all | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-153 | canvas_mark_all_entries_as_unread_courses | DELETE | /api/v1/courses/{course_id}/discussion_topics/{topic_id}/read_all | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-154 | canvas_mark_all_topic_as_read_courses | PUT | /api/v1/courses/{course_id}/discussion_topics/read_all | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-155 | canvas_mark_entry_as_read_courses | PUT | /api/v1/courses/{course_id}/discussion_topics/{topic_id}/entries/{entry_id}/read | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-156 | canvas_mark_entry_as_unread_courses | DELETE | /api/v1/courses/{course_id}/discussion_topics/{topic_id}/entries/{entry_id}/read | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-157 | canvas_mark_topic_as_read_courses | PUT | /api/v1/courses/{course_id}/discussion_topics/{topic_id}/read | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-158 | canvas_mark_topic_as_unread_courses | DELETE | /api/v1/courses/{course_id}/discussion_topics/{topic_id}/read | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-159 | canvas_post_entry_courses | POST | /api/v1/courses/{course_id}/discussion_topics/{topic_id}/entries | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-160 | canvas_post_reply_courses | POST | /api/v1/courses/{course_id}/discussion_topics/{topic_id}/entries/{entry_id}/replies | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-161 | canvas_rate_entry_courses | POST | /api/v1/courses/{course_id}/discussion_topics/{topic_id}/entries/{entry_id}/rating | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-162 | canvas_reorder_pinned_topics_courses | POST | /api/v1/courses/{course_id}/discussion_topics/reorder | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-163 | canvas_subscribe_to_topic_courses | PUT | /api/v1/courses/{course_id}/discussion_topics/{topic_id}/subscribed | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-164 | canvas_summary_feedback_courses | POST | /api/v1/courses/{course_id}/discussion_topics/{topic_id}/summaries/{summary_id}/feedback | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-165 | canvas_unsubscribe_from_topic_courses | DELETE | /api/v1/courses/{course_id}/discussion_topics/{topic_id}/subscribed | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-166 | canvas_update_entry_courses | PUT | /api/v1/courses/{course_id}/discussion_topics/{topic_id}/entries/{id} | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-167 | canvas_update_topic_courses | PUT | /api/v1/courses/{course_id}/discussion_topics/{topic_id} | W | canvas-batch | live-proven [LEARNER-DATA] | Discussion 1241942 renamed HTTP 200, readback 200 with exact title (2026-09-20, canvas-batch form lane) |

### enrollments (7)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-168 | canvas_accept_course_invitation | POST | /api/v1/courses/{course_id}/enrollments/{id}/accept | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-169 | canvas_add_last_attended_date | PUT | /api/v1/courses/{course_id}/users/{user_id}/last_attended | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-170 | canvas_conclude_deactivate_or_delete_enrollment | DELETE | /api/v1/courses/{course_id}/enrollments/{id} | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-171 | canvas_enroll_user_courses | POST | /api/v1/courses/{course_id}/enrollments | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-172 | canvas_list_enrollments_courses | GET | /api/v1/courses/{course_id}/enrollments | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-173 | canvas_re_activate_enrollment | PUT | /api/v1/courses/{course_id}/enrollments/{id}/reactivate | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-174 | canvas_reject_course_invitation | POST | /api/v1/courses/{course_id}/enrollments/{id}/reject | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### epub_exports (2)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-175 | canvas_create_epub_export | POST | /api/v1/courses/{course_id}/epub_exports | W | canvas-batch | unsupported | 2026-09-21 Chromium write battery: POST 500 genuine x2. Provider does not serve this route; moved to unsupported. |
| C-176 | canvas_show_epub_export | GET | /api/v1/courses/{course_id}/epub_exports/{id} | R | canvas-batch | pending |  |

### external_tools (7)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-177 | canvas_create_external_tool_courses | POST | /api/v1/courses/{course_id}/external_tools | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 201 id 313100. |
| C-178 | canvas_delete_external_tool_courses | DELETE | /api/v1/courses/{course_id}/external_tools/{external_tool_id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: DELETE 200. |
| C-179 | canvas_edit_external_tool_courses | PUT | /api/v1/courses/{course_id}/external_tools/{external_tool_id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PUT 200. |
| C-180 | canvas_get_sessionless_launch_url_for_external_tool_courses | GET | /api/v1/courses/{course_id}/external_tools/sessionless_launch | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: id,name,url. |
| C-181 | canvas_get_single_external_tool_courses | GET | /api/v1/courses/{course_id}/external_tools/{external_tool_id} | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: id,name,description,url,domain,consumer_key,created_at,updated_at,privacy_level,custom_fields. |
| C-182 | canvas_get_visible_course_navigation_tools_for_single_course | GET | /api/v1/courses/{course_id}/external_tools/visible_course_nav_tools | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[13]. |
| C-183 | canvas_list_external_tools_courses | GET | /api/v1/courses/{course_id}/external_tools | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[7]. |

### favorites (2)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-184 | canvas_add_course_to_favorites | POST | /api/v1/users/self/favorites/courses/{id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 200 add favorite. |
| C-185 | canvas_remove_course_from_favorites | DELETE | /api/v1/users/self/favorites/courses/{id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: DELETE 200 remove favorite. |

### feature_flags (5)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-186 | canvas_get_feature_flag_courses | GET | /api/v1/courses/{course_id}/features/flags/{feature} | R | canvas-batch | pending |  |
| C-187 | canvas_list_enabled_features_courses | GET | /api/v1/courses/{course_id}/features/enabled | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[20]. |
| C-188 | canvas_list_features_courses | GET | /api/v1/courses/{course_id}/features | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[6]. |
| C-189 | canvas_remove_feature_flag_courses | DELETE | /api/v1/courses/{course_id}/features/flags/{feature} | W | canvas-batch | excluded | Braden exclusion: feature flags affect subaccount-level feature state |
| C-190 | canvas_set_feature_flag_courses | PUT | /api/v1/courses/{course_id}/features/flags/{feature} | W | canvas-batch | excluded | Braden exclusion: feature flags affect subaccount-level feature state |

### files (14)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-191 | canvas_create_folder_courses | POST | /api/v1/courses/{course_id}/folders | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 200 folder id 1826336. |
| C-192 | canvas_get_file_courses | GET | /api/v1/courses/{course_id}/files/{id} | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: id,folder_id,display_name,filename,upload_status,content-type,url,size,created_at,updated_at. |
| C-193 | canvas_get_folder_courses | GET | /api/v1/courses/{course_id}/folders/{id} | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: id,name,full_name,position,parent_folder_id,context_type,context_id,unlock_at,lock_at,created_at. |
| C-194 | canvas_get_quota_information_courses | GET | /api/v1/courses/{course_id}/files/quota | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: quota,quota_used. |
| C-195 | canvas_get_uploaded_media_folder_for_user_courses | GET | /api/v1/courses/{course_id}/folders/media | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: id,name,full_name,position,parent_folder_id,context_type,context_id,unlock_at,lock_at,created_at. |
| C-196 | canvas_list_all_folders_courses | GET | /api/v1/courses/{course_id}/folders | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[10]. |
| C-197 | canvas_list_files_courses | GET | /api/v1/courses/{course_id}/files | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[10]. |
| C-198 | canvas_list_licenses_courses | GET | /api/v1/courses/{course_id}/content_licenses | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[8]. |
| C-199 | canvas_read_course_file_text | GET | /api/v1/courses/{course_id}/files/{file_id}/text | R | canvas-batch | pending |  |
| C-200 | canvas_remove_usage_rights_courses | DELETE | /api/v1/courses/{course_id}/usage_rights | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: DELETE 200 remove usage rights (1 file updated). |
| C-201 | canvas_resolve_path_courses | GET | /api/v1/courses/{course_id}/folders/by_path | R | canvas-batch | pending |  |
| C-202 | canvas_resolve_path_courses_full_path | GET | /api/v1/courses/{course_id}/folders/by_path/*full_path | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[1]. |
| C-203 | canvas_set_usage_rights_courses | PUT | /api/v1/courses/{course_id}/usage_rights | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PUT 200 set usage rights. |
| C-204 | canvas_translate_file_reference | GET | /api/v1/courses/{course_id}/files/file_ref/{migration_id} | R | canvas-batch | pending |  |

### grade_change_log (1)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-205 | canvas_query_by_course_audit_grade_change_courses_course_id_get | GET | /api/v1/audit/grade_change/courses/{course_id} | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### gradebook_history (4)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-206 | canvas_days_in_gradebook_history_for_this_course | GET | /api/v1/courses/{course_id}/gradebook_history/days | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-207 | canvas_details_for_given_date_in_gradebook_history_for_this_course | GET | /api/v1/courses/{course_id}/gradebook_history/{date} | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-208 | canvas_list_uncollated_submission_versions | GET | /api/v1/courses/{course_id}/gradebook_history/feed | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-209 | canvas_lists_submissions | GET | /api/v1/courses/{course_id}/gradebook_history/{date}/graders/{grader_id}/assignments/{assignment_id}/submissions | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### grading_periods (5)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-210 | canvas_batch_update_grading_periods_courses | PATCH | /api/v1/courses/{course_id}/grading_periods/batch_update | W | canvas-batch | pending |  |
| C-211 | canvas_delete_grading_period_courses | DELETE | /api/v1/courses/{course_id}/grading_periods/{id} | W | canvas-batch | pending |  |
| C-212 | canvas_get_single_grading_period | GET | /api/v1/courses/{course_id}/grading_periods/{id} | R | canvas-batch | pending |  |
| C-213 | canvas_list_grading_periods_courses | GET | /api/v1/courses/{course_id}/grading_periods | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: grading_periods,meta,can_create_grading_periods,grading_periods_read_only. |
| C-214 | canvas_update_single_grading_period | PUT | /api/v1/courses/{course_id}/grading_periods/{id} | W | canvas-batch | pending |  |

### grading_standards (5)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-215 | canvas_create_new_grading_standard_courses | POST | /api/v1/courses/{course_id}/grading_standards | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 200 id 42016 (top-level params). |
| C-216 | canvas_delete_grading_standard_courses | DELETE | /api/v1/courses/{course_id}/grading_standards/{grading_standard_id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: DELETE 200; terminal GET 404. |
| C-217 | canvas_get_single_grading_standard_in_context_courses | GET | /api/v1/courses/{course_id}/grading_standards/{grading_standard_id} | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: id,title,context_type,context_id,scaling_factor,points_based,grading_scheme. |
| C-218 | canvas_list_grading_standards_available_in_context_courses | GET | /api/v1/courses/{course_id}/grading_standards | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[123]. |
| C-219 | canvas_update_grading_standard_courses | PUT | /api/v1/courses/{course_id}/grading_standards/{grading_standard_id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PUT 200. |

### group_categories (6)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-220 | canvas_bulk_manage_differentiation_tags | POST | /api/v1/courses/{course_id}/group_categories/bulk_manage_differentiation_tag | W | canvas-batch | failed | 2026-09-21 Chromium write battery FAILED: POST 400/500: operations rejected, then genuine 500. |
| C-221 | canvas_create_group_category_courses | POST | /api/v1/courses/{course_id}/group_categories | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 201 id 2021 (no delete in catalog; residue per no-cleanup rule). |
| C-222 | canvas_export_tags_and_users_in_course | GET | /api/v1/courses/{course_id}/group_categories/export_tags | R | canvas-batch | pending |  |
| C-223 | canvas_get_differentiation_tag_candidate_count | GET | /api/v1/courses/{course_id}/group_categories/differentiation_tag_candidate_count | R | canvas-batch | pending |  |
| C-224 | canvas_import_differentiation_tags | POST | /api/v1/courses/{course_id}/group_categories/import_tags | W | canvas-batch | pending |  |
| C-225 | canvas_list_group_categories_for_context_courses | GET | /api/v1/courses/{course_id}/group_categories | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[1]. |

### groups (2)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-226 | canvas_bulk_fetch_user_tags_for_multiple_users_in_course | GET | /api/v1/courses/{course_id}/bulk_user_tags | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: . |
| C-227 | canvas_list_groups_available_in_context_courses | GET | /api/v1/courses/{course_id}/groups | R | canvas-batch | live-proven [LEARNER-DATA] | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[0]. |

### late_policy (3)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-228 | canvas_create_late_policy | POST | /api/v1/courses/{id}/late_policy | W | canvas-batch | pending |  |
| C-229 | canvas_get_late_policy | GET | /api/v1/courses/{id}/late_policy | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: late_policy. |
| C-230 | canvas_patch_late_policy | PATCH | /api/v1/courses/{id}/late_policy | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PATCH 204 (patched real policy to 30; prior unknown; disclosed). |

### learning_object_dates (11)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-231 | canvas_get_learning_object_s_date_information_assignments | GET | /api/v1/courses/{course_id}/assignments/{assignment_id}/date_details | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: id,due_at,unlock_at,lock_at,only_visible_to_overrides,visible_to_everyone,group_category_id,graded,overrides. |
| C-232 | canvas_get_learning_object_s_date_information_discussion_topics | GET | /api/v1/courses/{course_id}/discussion_topics/{discussion_topic_id}/date_details | R | canvas-batch | pending |  |
| C-233 | canvas_get_learning_object_s_date_information_files | GET | /api/v1/courses/{course_id}/files/{attachment_id}/date_details | R | canvas-batch | pending |  |
| C-234 | canvas_get_learning_object_s_date_information_modules | GET | /api/v1/courses/{course_id}/modules/{context_module_id}/date_details | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: id,unlock_at,only_visible_to_overrides,visible_to_everyone,graded,overrides. |
| C-235 | canvas_get_learning_object_s_date_information_pages | GET | /api/v1/courses/{course_id}/pages/{url_or_id}/date_details | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: id,unlock_at,lock_at,only_visible_to_overrides,visible_to_everyone,graded,overrides. |
| C-236 | canvas_get_learning_object_s_date_information_quizzes | GET | /api/v1/courses/{course_id}/quizzes/{quiz_id}/date_details | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: id,due_at,unlock_at,lock_at,only_visible_to_overrides,visible_to_everyone,group_category_id,graded,overrides. |
| C-237 | canvas_update_learning_object_s_date_information_assignments | PUT | /api/v1/courses/{course_id}/assignments/{assignment_id}/date_details | W | canvas-batch | failed | 2026-09-21 Chromium write battery FAILED: PUT 400: This API does not support files. |
| C-238 | canvas_update_learning_object_s_date_information_discussion_topics | PUT | /api/v1/courses/{course_id}/discussion_topics/{discussion_topic_id}/date_details | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PUT 204 discussion date_details. |
| C-239 | canvas_update_learning_object_s_date_information_files | PUT | /api/v1/courses/{course_id}/files/{attachment_id}/date_details | W | canvas-batch | failed | 2026-09-21 Chromium write battery FAILED: PUT 400: This API does not support files. |
| C-240 | canvas_update_learning_object_s_date_information_pages | PUT | /api/v1/courses/{course_id}/pages/{url_or_id}/date_details | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PUT 204 page date_details. |
| C-241 | canvas_update_learning_object_s_date_information_quizzes | PUT | /api/v1/courses/{course_id}/quizzes/{quiz_id}/date_details | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PUT 204 quiz date_details. |

### line_items (5)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-242 | canvas_create_line_item | POST | /api/lti/courses/{course_id}/line_items | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-243 | canvas_delete_line_item | DELETE | /api/lti/courses/{course_id}/line_items/{id} | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-244 | canvas_list_line_items | GET | /api/lti/courses/{course_id}/line_items | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-245 | canvas_show_line_item | GET | /api/lti/courses/{course_id}/line_items/{id} | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-246 | canvas_update_line_item | PUT | /api/lti/courses/{course_id}/line_items/{id} | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### liveassessments (4)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-247 | canvas_create_live_assessment_results | POST | /api/v1/courses/{course_id}/live_assessments/{assessment_id}/results | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-248 | canvas_create_or_find_live_assessment | POST | /api/v1/courses/{course_id}/live_assessments | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-249 | canvas_list_live_assessment_results | GET | /api/v1/courses/{course_id}/live_assessments/{assessment_id}/results | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-250 | canvas_list_live_assessments | GET | /api/v1/courses/{course_id}/live_assessments | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### lti_launch_definitions (1)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-251 | canvas_list_lti_launch_definitions_courses | GET | /api/v1/courses/{course_id}/lti_apps/launch_definitions | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[10]. |

### lti_resource_links (6)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-252 | canvas_bulk_create_lti_resource_links | POST | /api/v1/courses/{course_id}/lti_resource_links/bulk | W | canvas-batch | failed | 2026-09-21 Chromium write battery FAILED: POST 500 genuine x2 on correct /lti_resource_links/bulk. |
| C-253 | canvas_create_lti_resource_link | POST | /api/v1/courses/{course_id}/lti_resource_links | W | canvas-batch | failed | 2026-09-21 Chromium write battery FAILED: POST 422 invalid_url: No tool found (real tool + tool_id tried). |
| C-254 | canvas_delete_lti_resource_link | DELETE | /api/v1/courses/{course_id}/lti_resource_links/{id} | W | canvas-batch | failed | 2026-09-21 Chromium write battery FAILED: No anchor (create 422). |
| C-255 | canvas_list_lti_resource_links | GET | /api/v1/courses/{course_id}/lti_resource_links | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[1]. |
| C-256 | canvas_show_lti_resource_link | GET | /api/v1/courses/{course_id}/lti_resource_links/{id} | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: id,created_at,updated_at,context_external_tool_id,workflow_state,root_account_id,context_id,context_type,custom,lookup_uuid. |
| C-257 | canvas_update_lti_resource_link | PUT | /api/v1/courses/{course_id}/lti_resource_links/{id} | W | canvas-batch | failed | 2026-09-21 Chromium write battery FAILED: No anchor (create 422). |

### media_objects (2)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-258 | canvas_list_media_objects_courses_media_attachments | GET | /api/v1/courses/{course_id}/media_attachments | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[0]. |
| C-259 | canvas_list_media_objects_courses_media_objects | GET | /api/v1/courses/{course_id}/media_objects | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[0]. |

### moderated_grading (8)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-260 | canvas_bulk_select_provisional_grades | PUT | /api/v1/courses/{course_id}/assignments/{assignment_id}/provisional_grades/bulk_select | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-261 | canvas_list_students_selected_for_moderation | GET | /api/v1/courses/{course_id}/assignments/{assignment_id}/moderated_students | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-262 | canvas_publish_provisional_grades_for_assignment | POST | /api/v1/courses/{course_id}/assignments/{assignment_id}/provisional_grades/publish | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-263 | canvas_publish_provisional_grades_for_assignment_asynchronous | POST | /api/v1/courses/{course_id}/assignments/{assignment_id}/provisional_grades/publish_async | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-264 | canvas_select_provisional_grade | PUT | /api/v1/courses/{course_id}/assignments/{assignment_id}/provisional_grades/{provisional_grade_id}/select | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-265 | canvas_select_students_for_moderation | POST | /api/v1/courses/{course_id}/assignments/{assignment_id}/moderated_students | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-266 | canvas_show_provisional_grade_status_for_student_assignments_assignment_id_anonymous_provisional_grades_get | GET | /api/v1/courses/{course_id}/assignments/{assignment_id}/anonymous_provisional_grades/status | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-267 | canvas_show_provisional_grade_status_for_student_assignments_assignment_id_provisional_grades_status_get | GET | /api/v1/courses/{course_id}/assignments/{assignment_id}/provisional_grades/status | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### modules (17)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-268 | canvas_create_module | POST | /api/v1/courses/{course_id}/modules | W | canvas-batch | live-proven | Module 958488 created HTTP 201 ('Weasel Proof Module (delete me)', position 206, unpublished). Fixture: evidence/canvas-wave-c1/module-lifecycle-result.json 2026-09-21 Chromium write battery: POST 200 id 958491. |
| C-269 | canvas_create_module_item | POST | /api/v1/courses/{course_id}/modules/{module_id}/items | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 200 id 10058160. |
| C-270 | canvas_delete_module | DELETE | /api/v1/courses/{course_id}/modules/{id} | W | canvas-batch | live-proven | Module 958488 deleted HTTP 200; direct GET 404 and absent from the 100-module course list; no residue 2026-09-21 Chromium write battery: DELETE 200. |
| C-271 | canvas_delete_module_item | DELETE | /api/v1/courses/{course_id}/modules/{module_id}/items/{id} | W | canvas-batch | pending | 2026-09-21 Chromium write battery: DELETE 200 but terminal GET still 200 (absence not proven). The DELETE was accepted but the item remained readable; per the catalog proof standard this is partial proof only. Marked pending until a delete verifies gone with a terminal GET 404. |
| C-272 | canvas_get_module_item_sequence | GET | /api/v1/courses/{course_id}/module_item_sequence | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: items,modules. |
| C-273 | canvas_list_module_items | GET | /api/v1/courses/{course_id}/modules/{module_id}/items | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[10]. |
| C-274 | canvas_list_module_s_overrides | GET | /api/v1/courses/{course_id}/modules/{context_module_id}/assignment_overrides | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[0]. |
| C-275 | canvas_list_modules | GET | /api/v1/courses/{course_id}/modules | R | canvas-batch | live-proven | GET /api/v1/courses/89585/modules?per_page=100 returned 100 modules; used as the verify-gone check (no 'Weasel' names, id 958488 absent) |
| C-276 | canvas_mark_module_item_as_done_not_done | PUT | /api/v1/courses/{course_id}/modules/{module_id}/items/{id}/done | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PUT 200 mark done. |
| C-277 | canvas_mark_module_item_read | POST | /api/v1/courses/{course_id}/modules/{module_id}/items/{id}/mark_read | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 200 mark read. |
| C-278 | canvas_re_lock_module_progressions | PUT | /api/v1/courses/{course_id}/modules/{id}/relock | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PUT 200 relock. |
| C-279 | canvas_select_mastery_path | POST | /api/v1/courses/{course_id}/modules/{module_id}/items/{id}/select_mastery_path | W | canvas-batch | failed | 2026-09-21 Chromium write battery FAILED: POST 400: mastery paths not enabled. |
| C-280 | canvas_show_module | GET | /api/v1/courses/{course_id}/modules/{id} | R | canvas-batch | live-proven | Module 958488 readback HTTP 200 with exact name, before and after rename |
| C-281 | canvas_show_module_item | GET | /api/v1/courses/{course_id}/modules/{module_id}/items/{id} | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: id,position,title,indent,quiz_lti,type,module_id,published,unpublishable. |
| C-282 | canvas_update_module | PUT | /api/v1/courses/{course_id}/modules/{id} | W | canvas-batch | live-proven | Module 958488 renamed to 'Weasel Proof Module RENAMED' HTTP 200, readback confirmed the exact new name 2026-09-21 Chromium write battery: PUT 200. |
| C-283 | canvas_update_module_item | PUT | /api/v1/courses/{course_id}/modules/{module_id}/items/{id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PUT 200. |
| C-284 | canvas_update_module_s_overrides | PUT | /api/v1/courses/{course_id}/modules/{context_module_id}/assignment_overrides | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PUT 204 module overrides. |

### names_and_role (1)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-285 | canvas_list_course_memberships | GET | /api/lti/courses/{course_id}/names_and_roles | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### new-quizzes (14)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-286 | canvas_create_new_quiz | POST | /api/quiz/v1/courses/{course_id}/quizzes | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: quiz-object create/update/delete PROVEN through the Chromium lane (provider path only). C-286: POST 200, quiz ids 4045401/4045406/4045410/4045411. C-299: PATCH 200, readback title matched. C-289: DELETE 200, terminal GET 404. Question items are PROVEN at the provider path: C-287 POST 200 (id 11028920), C-298 PATCH 200, C-290 DELETE 200 (write-battery MATRIX.md). PROVEN 2026-09-22 through the full governed product pipeline (admission gate, mode check, journal, page-context transport): disposable quizzes 4049059 (P4) and 4049060 (P10) created via dispatch_entry, read back with title match, updated, deleted with terminal GET 404, zero leftovers. admission_policy.json v1.2.0 lifted the evidence hold (admitted_on_proof). Question items proven through the governed pipeline 2026-09-22: C-287 choice create (items 11057310/11057311), C-293 readback, C-298 entry-nested PATCH with interaction-id preservation, reorder via PATCH position, C-290 delete with absence verification. NOT proven: publish. This supersedes the stale 2026-09-21 correction (401-under-quiz.build reading and the false 4045374 claim are retired). |
| C-287 | canvas_create_quiz_item | POST | /api/quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 200 id 11028920 (entry-nested; top-level 400 entry is missing). |
| C-288 | canvas_create_quiz_report_course_id_quizzes_assignment_id_reports_post | POST | /api/quiz/v1/courses/{course_id}/quizzes/{assignment_id}/reports | W | canvas-batch | failed | 2026-09-21 Chromium write battery FAILED: POST 400 invalid quiz report type (both types rejected). |
| C-289 | canvas_delete_new_quiz | DELETE | /api/quiz/v1/courses/{course_id}/quizzes/{assignment_id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: DELETE 200, terminal GET 404. Proof scope: quiz-object lifecycle only; publish and question items not proven (see C-286). |
| C-290 | canvas_delete_quiz_item | DELETE | /api/quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: DELETE 200 id 11028920. |
| C-291 | canvas_get_items_media_upload_url | GET | /api/quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/media_upload_url | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: url. |
| C-292 | canvas_get_new_quiz | GET | /api/quiz/v1/courses/{course_id}/quizzes/{assignment_id} | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: id,title,instructions,assignment_group_id,points_possible,due_at,lock_at,unlock_at,published,grading_type. |
| C-293 | canvas_get_quiz_item | GET | /api/quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id} | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: id,position,points_possible,properties,entry_type,entry_editable,stimulus_quiz_entry_id,status,entry. |
| C-294 | canvas_list_new_quizzes | GET | /api/quiz/v1/courses/{course_id}/quizzes | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[10]. |
| C-295 | canvas_list_quiz_items | GET | /api/quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[11]. |
| C-296 | canvas_set_course_level_accommodations | POST | /api/quiz/v1/courses/{course_id}/accommodations | W | canvas-batch | pending |  |
| C-297 | canvas_set_quiz_level_accommodations | POST | /api/quiz/v1/courses/{course_id}/quizzes/{assignment_id}/accommodations | W | canvas-batch | pending |  |
| C-298 | canvas_update_quiz_item | PATCH | /api/quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PATCH 200 id 11028920 (entry-nested update). |
| C-299 | canvas_update_single_quiz | PATCH | /api/quiz/v1/courses/{course_id}/quizzes/{assignment_id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PATCH 200, readback title matched. Proof scope: quiz-object lifecycle only; publish and question items not proven (see C-286). |

### outcome_groups (13)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-300 | canvas_create_link_outcome_courses | POST | /api/v1/courses/{course_id}/outcome_groups/{id}/outcomes | W | canvas-batch | pending |  |
| C-301 | canvas_create_link_outcome_courses_outcome_id | PUT | /api/v1/courses/{course_id}/outcome_groups/{id}/outcomes/{outcome_id} | W | canvas-batch | pending |  |
| C-302 | canvas_create_subgroup_courses | POST | /api/v1/courses/{course_id}/outcome_groups/{id}/subgroups | W | canvas-batch | pending |  |
| C-303 | canvas_delete_outcome_group_courses | DELETE | /api/v1/courses/{course_id}/outcome_groups/{id} | W | canvas-batch | pending |  |
| C-304 | canvas_get_all_outcome_groups_for_context_courses | GET | /api/v1/courses/{course_id}/outcome_groups | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[1]. |
| C-305 | canvas_get_all_outcome_links_for_context_courses | GET | /api/v1/courses/{course_id}/outcome_group_links | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[1]. |
| C-306 | canvas_import_outcome_group_courses | POST | /api/v1/courses/{course_id}/outcome_groups/{id}/import | W | canvas-batch | pending |  |
| C-307 | canvas_list_linked_outcomes_courses | GET | /api/v1/courses/{course_id}/outcome_groups/{id}/outcomes | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[1]. |
| C-308 | canvas_list_subgroups_courses | GET | /api/v1/courses/{course_id}/outcome_groups/{id}/subgroups | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[0]. |
| C-309 | canvas_redirect_to_root_outcome_group_for_context_courses | GET | /api/v1/courses/{course_id}/root_outcome_group | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: id,title,vendor_guid,url,subgroups_url,outcomes_url,can_edit,import_url,context_id,context_type. |
| C-310 | canvas_show_outcome_group_courses | GET | /api/v1/courses/{course_id}/outcome_groups/{id} | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: id,title,vendor_guid,url,subgroups_url,outcomes_url,can_edit,import_url,context_id,context_type. |
| C-311 | canvas_unlink_outcome_courses | DELETE | /api/v1/courses/{course_id}/outcome_groups/{id}/outcomes/{outcome_id} | W | canvas-batch | pending |  |
| C-312 | canvas_update_outcome_group_courses | PUT | /api/v1/courses/{course_id}/outcome_groups/{id} | W | canvas-batch | pending |  |

### outcome_imports (3)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-313 | canvas_get_ids_of_outcome_groups_created_after_successful_import_courses | GET | /api/v1/courses/{course_id}/outcome_imports/{id}/created_group_ids | R | canvas-batch | pending |  |
| C-314 | canvas_get_outcome_import_status_courses | GET | /api/v1/courses/{course_id}/outcome_imports/{id} | R | canvas-batch | pending |  |
| C-315 | canvas_import_outcomes_courses | POST | /api/v1/courses/{course_id}/outcome_imports | W | canvas-batch | pending |  |

### outcome_results (6)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-316 | canvas_enqueue_delayed_outcome_rollup_calculation_job | POST | /api/v1/courses/{course_id}/enqueue_outcome_rollup_calculation | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-317 | canvas_get_contributing_scores | GET | /api/v1/courses/{course_id}/outcomes/{outcome_id}/contributing_scores | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-318 | canvas_get_mastery_distribution | GET | /api/v1/courses/{course_id}/outcome_mastery_distribution | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-319 | canvas_get_outcome_result_rollups | GET | /api/v1/courses/{course_id}/outcome_rollups | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-320 | canvas_get_outcome_results | GET | /api/v1/courses/{course_id}/outcome_results | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-321 | canvas_set_outcome_ordering_for_lmgb | POST | /api/v1/courses/{course_id}/assign_outcome_order | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### outcomes (1)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-322 | canvas_get_outcome_alignments_for_student_or_assignment | GET | /api/v1/courses/{course_id}/outcome_alignments | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[0]. |

### pages (12)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-323 | canvas_create_page_courses | POST | /api/v1/courses/{course_id}/pages | W | canvas-batch | live-proven | Page 3467772 created HTTP 201 (slug weasel-proof-page-delete-me). Live contract: Canvas Pages uses wiki_page[title] and wiki_page[body]. Fixture: evidence/canvas-wave-c1/page-lifecycle-result.json 2026-09-21 Chromium write battery: POST 200 slug morrowproofcurrent-wbmub8w6ej-page. |
| C-324 | canvas_delete_page_courses | DELETE | /api/v1/courses/{course_id}/pages/{url_or_id} | W | canvas-batch | live-proven | Page 3467772 deleted HTTP 200; both slugs GET 404; 'weasel' search empty; no page residue 2026-09-21 Chromium write battery: DELETE 200; terminal GET 404. |
| C-325 | canvas_duplicate_page | POST | /api/v1/courses/{course_id}/pages/{url_or_id}/duplicate | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 200 duplicate. |
| C-326 | canvas_list_pages_courses | GET | /api/v1/courses/{course_id}/pages | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[10]. |
| C-327 | canvas_list_revisions_courses | GET | /api/v1/courses/{course_id}/pages/{url_or_id}/revisions | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[10]. |
| C-328 | canvas_revert_to_revision_courses | POST | /api/v1/courses/{course_id}/pages/{url_or_id}/revisions/{revision_id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 200 revert to revision. |
| C-329 | canvas_show_front_page_courses | GET | /api/v1/courses/{course_id}/front_page | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: url,title,created_at,editing_roles,page_id,last_edited_by,published,hide_from_students,front_page,html_url. |
| C-330 | canvas_show_page_courses | GET | /api/v1/courses/{course_id}/pages/{url_or_id} | R | canvas-batch | live-proven | Page 3467772 readback HTTP 200 under both the original and the regenerated slug |
| C-331 | canvas_show_revision_courses_latest | GET | /api/v1/courses/{course_id}/pages/{url_or_id}/revisions/latest | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: revision_id,updated_at,latest,url,title,body,edited_by. |
| C-332 | canvas_show_revision_courses_revision_id | GET | /api/v1/courses/{course_id}/pages/{url_or_id}/revisions/{revision_id} | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: revision_id,updated_at,latest,url,title,body,edited_by. |
| C-333 | canvas_update_create_front_page_courses | PUT | /api/v1/courses/{course_id}/front_page | W | canvas-batch | failed | 2026-09-21 Chromium write battery FAILED: PUT 200 but returned original front page; no verified state change. |
| C-334 | canvas_update_create_page_courses | PUT | /api/v1/courses/{course_id}/pages/{url_or_id} | W | canvas-batch | live-proven | Page 3467772 renamed HTTP 200; Canvas regenerated the slug to weasel-proof-page-renamed 2026-09-21 Chromium write battery: PUT 200; readback matched. |

### peer_reviews (5)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-335 | canvas_allocate_peer_review | POST | /api/v1/courses/{course_id}/assignments/{assignment_id}/allocate | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-336 | canvas_create_peer_review_courses | POST | /api/v1/courses/{course_id}/assignments/{assignment_id}/submissions/{submission_id}/peer_reviews | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-337 | canvas_delete_peer_review_courses | DELETE | /api/v1/courses/{course_id}/assignments/{assignment_id}/submissions/{submission_id}/peer_reviews | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-338 | canvas_get_all_peer_reviews_courses_peer_reviews | GET | /api/v1/courses/{course_id}/assignments/{assignment_id}/peer_reviews | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-339 | canvas_get_all_peer_reviews_courses_submissions | GET | /api/v1/courses/{course_id}/assignments/{assignment_id}/submissions/{submission_id}/peer_reviews | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### proficiency_ratings (2)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-340 | canvas_create_update_proficiency_ratings_courses | POST | /api/v1/courses/{course_id}/outcome_proficiency | W | canvas-batch | pending |  |
| C-341 | canvas_get_proficiency_ratings_courses | GET | /api/v1/courses/{course_id}/outcome_proficiency | R | canvas-batch | pending |  |

### progress (1)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-342 | canvas_query_progress_courses_course_id_progress_id_get | GET | /api/lti/courses/{course_id}/progress/{id} | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### quiz_assignment_overrides (2)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-343 | canvas_retrieve_assignment_overridden_dates_for_classic_quizzes | GET | /api/v1/courses/{course_id}/quizzes/assignment_overrides | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: quiz_assignment_overrides. |
| C-344 | canvas_retrieve_assignment_overridden_dates_for_new_quizzes | GET | /api/v1/courses/{course_id}/new_quizzes/assignment_overrides | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: quiz_assignment_overrides. |

### quiz_extensions (1)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-345 | canvas_set_extensions_for_student_quiz_submissions_course_id_quizzes_quiz_id_extensions_post | POST | /api/v1/courses/{course_id}/quizzes/{quiz_id}/extensions | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### quiz_ip_filters (1)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-346 | canvas_get_available_quiz_ip_filters | GET | /api/v1/courses/{course_id}/quizzes/{quiz_id}/ip_filters | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: quiz_ip_filters. |

### quiz_question_groups (6)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-347 | canvas_create_question_group | POST | /api/v1/courses/{course_id}/quizzes/{quiz_id}/groups | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 201 id 47372. |
| C-348 | canvas_delete_question_group | DELETE | /api/v1/courses/{course_id}/quizzes/{quiz_id}/groups/{id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: DELETE 204. |
| C-349 | canvas_get_single_quiz_group | GET | /api/v1/courses/{course_id}/quizzes/{quiz_id}/groups/{id} | R | canvas-batch | pending |  |
| C-350 | canvas_list_question_groups_in_quiz | GET | /api/v1/courses/{course_id}/quizzes/{quiz_id}/groups | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: quiz_groups. |
| C-351 | canvas_reorder_question_groups | POST | /api/v1/courses/{course_id}/quizzes/{quiz_id}/groups/{id}/reorder | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 204 reorder (array body). |
| C-352 | canvas_update_question_group | PUT | /api/v1/courses/{course_id}/quizzes/{quiz_id}/groups/{id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PUT 200. |

### quiz_questions (5)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-353 | canvas_create_single_quiz_question | POST | /api/v1/courses/{course_id}/quizzes/{quiz_id}/questions | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 200 id 6797992. |
| C-354 | canvas_delete_quiz_question | DELETE | /api/v1/courses/{course_id}/quizzes/{quiz_id}/questions/{id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: DELETE 204. |
| C-355 | canvas_get_single_quiz_question | GET | /api/v1/courses/{course_id}/quizzes/{quiz_id}/questions/{id} | R | canvas-batch | pending |  |
| C-356 | canvas_list_questions_in_quiz_or_submission | GET | /api/v1/courses/{course_id}/quizzes/{quiz_id}/questions | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[0]. |
| C-357 | canvas_update_existing_quiz_question | PUT | /api/v1/courses/{course_id}/quizzes/{quiz_id}/questions/{id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PUT 200. |

### quiz_reports (4)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-358 | canvas_abort_generation_of_report_or_remove_previously_generated_one | DELETE | /api/v1/courses/{course_id}/quizzes/{quiz_id}/reports/{id} | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-359 | canvas_create_quiz_report_course_id_quizzes_quiz_id_reports_post | POST | /api/v1/courses/{course_id}/quizzes/{quiz_id}/reports | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-360 | canvas_get_quiz_report | GET | /api/v1/courses/{course_id}/quizzes/{quiz_id}/reports/{id} | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-361 | canvas_retrieve_all_quiz_reports | GET | /api/v1/courses/{course_id}/quizzes/{quiz_id}/reports | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### quiz_statistics (1)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-362 | canvas_fetching_latest_quiz_statistics | GET | /api/v1/courses/{course_id}/quizzes/{quiz_id}/statistics | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### quiz_submission_events (2)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-363 | canvas_retrieve_captured_events | GET | /api/v1/courses/{course_id}/quizzes/{quiz_id}/submissions/{id}/events | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-364 | canvas_submit_captured_events | POST | /api/v1/courses/{course_id}/quizzes/{quiz_id}/submissions/{id}/events | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### quiz_submission_files (1)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-365 | canvas_upload_file_quiz_id_submissions_self_files_post | POST | /api/v1/courses/{course_id}/quizzes/{quiz_id}/submissions/self/files | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### quiz_submission_user_list (1)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-366 | canvas_send_message_to_unsubmitted_or_submitted_users_for_quiz | POST | /api/v1/courses/{course_id}/quizzes/{id}/submission_users/message | W | canvas-batch | excluded [LEARNER-DATA] | Braden exclusion: sends messages to people (messages quiz takers) |

### quiz_submissions (7)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-367 | canvas_complete_quiz_submission_turn_it_in | POST | /api/v1/courses/{course_id}/quizzes/{quiz_id}/submissions/{id}/complete | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-368 | canvas_create_quiz_submission_start_quiz_taking_session | POST | /api/v1/courses/{course_id}/quizzes/{quiz_id}/submissions | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-369 | canvas_get_all_quiz_submissions | GET | /api/v1/courses/{course_id}/quizzes/{quiz_id}/submissions | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-370 | canvas_get_current_quiz_submission_times | GET | /api/v1/courses/{course_id}/quizzes/{quiz_id}/submissions/{id}/time | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-371 | canvas_get_quiz_submission | GET | /api/v1/courses/{course_id}/quizzes/{quiz_id}/submission | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-372 | canvas_get_single_quiz_submission | GET | /api/v1/courses/{course_id}/quizzes/{quiz_id}/submissions/{id} | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-373 | canvas_update_student_question_scores_and_comments | PUT | /api/v1/courses/{course_id}/quizzes/{quiz_id}/submissions/{id} | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### quizzes (7)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-374 | canvas_create_quiz | POST | /api/v1/courses/{course_id}/quizzes | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 200 id 338345. |
| C-375 | canvas_delete_quiz | DELETE | /api/v1/courses/{course_id}/quizzes/{id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: DELETE 200. |
| C-376 | canvas_edit_quiz | PUT | /api/v1/courses/{course_id}/quizzes/{id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PUT 200. |
| C-377 | canvas_get_single_quiz | GET | /api/v1/courses/{course_id}/quizzes/{id} | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: id,title,html_url,mobile_url,description,quiz_type,time_limit,timer_autosubmit_disabled,shuffle_answers,show_correct_answers. |
| C-378 | canvas_list_quizzes_in_course | GET | /api/v1/courses/{course_id}/quizzes | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[10]. |
| C-379 | canvas_reorder_quiz_items | POST | /api/v1/courses/{course_id}/quizzes/{id}/reorder | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 204 reorder (array body). |
| C-380 | canvas_validate_quiz_access_code | POST | /api/v1/courses/{course_id}/quizzes/{id}/validate_access_code | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 200 wrong code returns false. |

### result (2)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-381 | canvas_show_collection_of_results | GET | /api/lti/courses/{course_id}/line_items/{line_item_id}/results | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-382 | canvas_show_result | GET | /api/lti/courses/{course_id}/line_items/{line_item_id}/results/{id} | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### rubrics (14)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-383 | canvas_create_rubricassociation | POST | /api/v1/courses/{course_id}/rubric_associations | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 200 association id 1408201. |
| C-384 | canvas_create_single_rubric | POST | /api/v1/courses/{course_id}/rubrics | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 200 id 560629. |
| C-385 | canvas_create_single_rubric_assessment | POST | /api/v1/courses/{course_id}/rubric_associations/{rubric_association_id}/rubric_assessments | W | canvas-batch | pending |  |
| C-386 | canvas_creates_rubric_using_csv_file_courses | POST | /api/v1/courses/{course_id}/rubrics/upload | W | canvas-batch | failed | 2026-09-21 Chromium write battery FAILED: POST 400 No file attached (4 field variants). |
| C-387 | canvas_delete_rubricassociation | DELETE | /api/v1/courses/{course_id}/rubric_associations/{id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: DELETE 200. |
| C-388 | canvas_delete_single | DELETE | /api/v1/courses/{course_id}/rubrics/{id} | W | canvas-batch | failed | 2026-09-21 Chromium write battery FAILED: DELETE 500 genuine x3; rubric absent on GET after. |
| C-389 | canvas_delete_single_rubric_assessment | DELETE | /api/v1/courses/{course_id}/rubric_associations/{rubric_association_id}/rubric_assessments/{id} | W | canvas-batch | pending |  |
| C-390 | canvas_get_courses_and_assignments_for_rubric_courses | GET | /api/v1/courses/{course_id}/rubrics/{id}/used_locations | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[1]. |
| C-391 | canvas_get_single_rubric_courses | GET | /api/v1/courses/{course_id}/rubrics/{id} | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: id,title,context_id,context_type,points_possible,reusable,public,read_only,free_form_criterion_comments,hide_score_total. |
| C-392 | canvas_get_status_of_rubric_import_courses | GET | /api/v1/courses/{course_id}/rubrics/upload/{id} | R | canvas-batch | pending |  |
| C-393 | canvas_list_rubrics_courses | GET | /api/v1/courses/{course_id}/rubrics | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[10]. |
| C-394 | canvas_update_rubricassociation | PUT | /api/v1/courses/{course_id}/rubric_associations/{id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PUT 200. |
| C-395 | canvas_update_single_rubric | PUT | /api/v1/courses/{course_id}/rubrics/{id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PUT 200. |
| C-396 | canvas_update_single_rubric_assessment | PUT | /api/v1/courses/{course_id}/rubric_associations/{rubric_association_id}/rubric_assessments/{id} | W | canvas-batch | pending |  |

### score (1)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-397 | canvas_create_score | POST | /api/lti/courses/{course_id}/line_items/{line_item_id}/scores | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### sections (3)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-398 | canvas_create_course_section | POST | /api/v1/courses/{course_id}/sections | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: POST 200 sections 95414/95415/95416; deletes 200. |
| C-399 | canvas_get_section_information_courses | GET | /api/v1/courses/{course_id}/sections/{id} | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: id,name,course_id,nonxlist_course_id,start_at,end_at,restrict_enrollments_to_section_dates,created_at,sis_section_id,sis_course_id. |
| C-400 | canvas_list_course_sections | GET | /api/v1/courses/{course_id}/sections | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[1]. |

### sis_integration (2)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-401 | canvas_disable_assignments_currently_enabled_for_grade_export_to_sis | PUT | /api/sis/courses/{course_id}/disable_post_to_sis | W | canvas-batch | excluded | Braden exclusion: affects SIS grade export (subaccount/institution state) 2026-09-21 Chromium write battery: PUT 204 disable_post_to_sis=false (catalog marks excluded; live 204). Stays excluded: Braden exclusion (affects subaccount). |
| C-402 | canvas_retrieve_assignments_enabled_for_grade_export_to_sis_courses | GET | /api/sis/courses/{course_id}/assignments | R | canvas-batch | pending |  |

### smart_search (1)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-403 | canvas_search_course_content | GET | /api/v1/courses/{course_id}/smartsearch | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body object keys: results. |

### study_assist (1)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-404 | canvas_request_study_assist_response | POST | /api/v1/courses/{course_id}/study_assist | W | canvas-batch | unsupported | 2026-09-21 Chromium write battery: POST 404 Study tools not enabled. Provider does not serve this route; moved to unsupported. |

### submission_comments (4)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-405 | canvas_delete_submission_comment | DELETE | /api/v1/courses/{course_id}/assignments/{assignment_id}/submissions/{user_id}/comments/{id} | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-406 | canvas_edit_submission_comment | PUT | /api/v1/courses/{course_id}/assignments/{assignment_id}/submissions/{user_id}/comments/{id} | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-407 | canvas_send_annotation_notification | POST | /api/v1/courses/{course_id}/assignments/{assignment_id}/submissions/{user_id}/annotation_notification | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-408 | canvas_upload_file_submissions_user_id_comments_files_post | POST | /api/v1/courses/{course_id}/assignments/{assignment_id}/submissions/{user_id}/comments/files | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### submissions (24)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-409 | canvas_clear_unread_status_for_all_submissions_courses | PUT | /api/v1/courses/{course_id}/submissions/{user_id}/clear_unread | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-410 | canvas_get_document_annotations_read_state_courses | GET | /api/v1/courses/{course_id}/assignments/{assignment_id}/submissions/{user_id}/document_annotations/read | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-411 | canvas_get_rubric_assessments_read_state_courses_rubric_assessments | GET | /api/v1/courses/{course_id}/assignments/{assignment_id}/submissions/{user_id}/rubric_assessments/read | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-412 | canvas_get_rubric_assessments_read_state_courses_rubric_comments | GET | /api/v1/courses/{course_id}/assignments/{assignment_id}/submissions/{user_id}/rubric_comments/read | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-413 | canvas_get_single_submission_by_anonymous_id_courses | GET | /api/v1/courses/{course_id}/assignments/{assignment_id}/anonymous_submissions/{anonymous_id} | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-414 | canvas_get_single_submission_courses | GET | /api/v1/courses/{course_id}/assignments/{assignment_id}/submissions/{user_id} | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-415 | canvas_grade_or_comment_on_multiple_submissions_courses_assignments | POST | /api/v1/courses/{course_id}/assignments/{assignment_id}/submissions/update_grades | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-416 | canvas_grade_or_comment_on_multiple_submissions_courses_submissions | POST | /api/v1/courses/{course_id}/submissions/update_grades | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-417 | canvas_grade_or_comment_on_submission_by_anonymous_id_courses | PUT | /api/v1/courses/{course_id}/assignments/{assignment_id}/anonymous_submissions/{anonymous_id} | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-418 | canvas_grade_or_comment_on_submission_courses | PUT | /api/v1/courses/{course_id}/assignments/{assignment_id}/submissions/{user_id} | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-419 | canvas_list_assignment_submissions_courses | GET | /api/v1/courses/{course_id}/assignments/{assignment_id}/submissions | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-420 | canvas_list_gradeable_students | GET | /api/v1/courses/{course_id}/assignments/{assignment_id}/gradeable_students | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-421 | canvas_list_multiple_assignments_gradeable_students | GET | /api/v1/courses/{course_id}/assignments/gradeable_students | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-422 | canvas_list_submissions_for_multiple_assignments_courses | GET | /api/v1/courses/{course_id}/students/submissions | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-423 | canvas_mark_bulk_submissions_as_read_courses | PUT | /api/v1/courses/{course_id}/submissions/bulk_mark_read | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-424 | canvas_mark_document_annotations_as_read_courses | PUT | /api/v1/courses/{course_id}/assignments/{assignment_id}/submissions/{user_id}/document_annotations/read | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-425 | canvas_mark_rubric_assessments_as_read_courses_rubric_assessments | PUT | /api/v1/courses/{course_id}/assignments/{assignment_id}/submissions/{user_id}/rubric_assessments/read | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-426 | canvas_mark_rubric_assessments_as_read_courses_rubric_comments | PUT | /api/v1/courses/{course_id}/assignments/{assignment_id}/submissions/{user_id}/rubric_comments/read | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-427 | canvas_mark_submission_as_read_courses | PUT | /api/v1/courses/{course_id}/assignments/{assignment_id}/submissions/{user_id}/read | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-428 | canvas_mark_submission_as_unread_courses | DELETE | /api/v1/courses/{course_id}/assignments/{assignment_id}/submissions/{user_id}/read | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-429 | canvas_mark_submission_item_as_read_courses | PUT | /api/v1/courses/{course_id}/assignments/{assignment_id}/submissions/{user_id}/read/{item} | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-430 | canvas_submission_summary_courses | GET | /api/v1/courses/{course_id}/assignments/{assignment_id}/submission_summary | R | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-431 | canvas_submit_assignment_courses | POST | /api/v1/courses/{course_id}/assignments/{assignment_id}/submissions | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| C-432 | canvas_upload_file_courses | POST | /api/v1/courses/{course_id}/assignments/{assignment_id}/submissions/{user_id}/files | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### tabs (2)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-433 | canvas_list_available_tabs_for_course_or_group_courses | GET | /api/v1/courses/{course_id}/tabs | R | canvas-batch | live-proven | 2026-09-21 Chromium GET battery: HTTP 200 verified live (in-page fetch, CDP); body array[51]. |
| C-434 | canvas_update_tab_for_course | PUT | /api/v1/courses/{course_id}/tabs/{tab_id} | W | canvas-batch | live-proven | 2026-09-21 Chromium write battery: PUT 200 people-tab toggle; restored 200. |

### what_if_grades (1)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-435 | canvas_reset_what_if_scores_for_current_user_for_entire_course_and_recalculate_grades | PUT | /api/v1/courses/{course_id}/what_if_grades/reset | W | canvas-batch | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### users_self (1)

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| C-436 | users_self | GET | /api/v1/users/self | R | canvas-batch | live-proven | Added 2026-09-21 (wave-3 hardening, W3-P0-15): the educator's own profile read. NOT learner data: admission policy url_exceptions covers /users/self, so the learner-data gate stays exempt. 2026-09-21: LIVE-PROVEN through the helper Chromium (historical note: TCP CDP 127.0.0.1:19223, removed 2026-09-21 by W4-P0-3; the lane now attaches through the verified launcher): GET /api/v1/users/self returned 200 with id 28206, name Braden Riggins, login briggins@chcp.edu (this tenant's response carries no login_id field; email is the account identifier). Evidence: proof-battery/evidence/users_self_proof_USERS-SELF-20260921T220055Z.json |

## Item Bank quiz-api operations (20)

These run on the quiz-api host with the LTI-provisioned banks.build token, not on Canvas course paths. The executor's Chromium lane egresses every /api/banks/... path through transport/item_bank_sdk.py (mechanism item-banks-sdk): dynamic Item Banks LTI tool resolution, course-scoped launch, CDP capture of the Authorization request headers from tenant-bound quiz-api traffic (token held in memory only, never logged or persisted), per-tenant quiz-api origin derivation, and item fetches evaluated in the tab root frame's isolated world. The archive action is the provider's whole-bank delete; there is no whole-quiz delete or archive (see the New Quiz sequence table). Bank sharing is proven (Wave 1/2, 2026-09-20); no unshare via DELETE (404s); unshare is PATCH /api/banks/{bank}/shared_banks/{id} with {shared_bank:{permission:"removed_access"}} (proven 2026-09-21, share 38934; list verified clean). quiz_entries routes need a different authorization scope (401 under banks.build).

| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |
|---|------|--------|------|----|-----------|--------|------------------|
| IB-1 | canvas_item_bank_archive_bank | DELETE | /api/banks/{bank_id} | W | item-banks-sdk | live-proven | DEPLOY.md 4-8: bank 4041 op 884eb821-d3b6-4ca9-b04f-80de9d851d99, bank 4040 op 4438579d-9b73-4745-8664-47e52dcae508; pre-deploy bank 4037; all archived=true and absent from the live list 2026-09-21 Chromium write battery: DELETE 204 archive; readback archived_flag. 2026-09-21: executor Chromium lane now egresses this path via transport/item_bank_sdk.py (same banks.build mechanism the batteries proved); executor-pipeline live proof 2026-09-22 (Lane 6 live battery): DELETE 204 archive bank 4076; absent from bank list after. 2026-09-22 Lane 6 live battery: executor-pipeline live proof through dispatch/executor.py + transport/item_bank_sdk.py (course 89585, disposable objects, full cleanup; evidence ~/workspace/audits/earthshake-2026-09-22/lane6-live-battery.log). Independently re-proven 2026-09-22 by the Lane 6 rerun (31/31 checks, EXIT=0): disposable bank 4078, item 11269650, entry 82776, share 39208; entry deleted 204, share unshared, bank archived 204 with absence verified, zero title leftovers. Evidence: ~/workspace/audits/earthshake-2026-09-22/lane6-live-battery-rerun.log. |
| IB-2 | canvas_item_bank_attach_bank_entry_to_quiz | POST | /api/quizzes/{builder_quiz_id}/quiz_entries | W | quiz-api-token | evidence-hold | Wave 2 (W2E): all quiz_entries routes -> 401 under the banks.build scope (list, attach entry, attach bank, delete); the scope has no policy for quiz_entries. Requires a different authorization scope. Quiz 506477 untouched. Held 2026-09-21: credential path rewritten (provision/launch_driver.py exists and is integrated into dispatch/executor.py); no live battery has proven the path; refused on every tenant until one does. 2026-09-21 Chromium write battery BLOCKED: confirmed 401 (scope has no quiz_entries policy); hold stands. |
| IB-3 | canvas_item_bank_attach_bank_to_quiz | POST | /api/quizzes/{builder_quiz_id}/quiz_entries | W | quiz-api-token | evidence-hold | Wave 2 (W2E): all quiz_entries routes -> 401 under the banks.build scope (list, attach entry, attach bank, delete); the scope has no policy for quiz_entries. Requires a different authorization scope. Quiz 506477 untouched. Held 2026-09-21: credential path rewritten (provision/launch_driver.py exists and is integrated into dispatch/executor.py); no live battery has proven the path; refused on every tenant until one does. 2026-09-21 Chromium write battery BLOCKED: confirmed 401 (scope has no quiz_entries policy); hold stands. |
| IB-4 | canvas_item_bank_attach_item | POST | /api/banks/{bank_id}/bank_entries | W | item-banks-sdk | live-proven | 2026-09-22 Lane 6 live battery: executor-pipeline live proof through dispatch/executor.py + transport/item_bank_sdk.py: POST 201 entry 82774 (item 11269645 attached to disposable bank 4076, course 89585); entry removed 204; entries list verified clean; bank archived 204, absent from bank list. Full cleanup. The 2026-09-21 'No anchor' failure was the old canvas-origin path; the SDK lane is the only Item Banks lane. Evidence: ~/workspace/audits/earthshake-2026-09-22/lane6-live-battery.log. Independently re-proven 2026-09-22 by the Lane 6 rerun (31/31 checks, EXIT=0): disposable bank 4078, item 11269650, entry 82776, share 39208; entry deleted 204, share unshared, bank archived 204 with absence verified, zero title leftovers. Evidence: ~/workspace/audits/earthshake-2026-09-22/lane6-live-battery-rerun.log. |
| IB-5 | canvas_item_bank_create_bank | POST | /api/banks | W | item-banks-sdk | live-proven | DEPLOY.md 4-8: bank 4041 op 5f16277b-5514-4700-add8-05cbd9a2bbcf; bank 4040 cleanup op 4438579d-9b73-4745-8664-47e52dcae508; pre-deploy battery bank 4037 (item_bank_battery_results.json) 2026-09-21 Chromium write battery: POST 201 banks 4053/4054/4055/4056. 2026-09-21: executor Chromium lane now egresses this path via transport/item_bank_sdk.py (same banks.build mechanism the batteries proved); executor-pipeline live proof 2026-09-22 (Lane 6 live battery): POST 201 bank 4076; bank GET readback passed (title match). 2026-09-22 Lane 6 live battery: executor-pipeline live proof through dispatch/executor.py + transport/item_bank_sdk.py (course 89585, disposable objects, full cleanup; evidence ~/workspace/audits/earthshake-2026-09-22/lane6-live-battery.log). Independently re-proven 2026-09-22 by the Lane 6 rerun (31/31 checks, EXIT=0): disposable bank 4078, item 11269650, entry 82776, share 39208; entry deleted 204, share unshared, bank archived 204 with absence verified, zero title leftovers. Evidence: ~/workspace/audits/earthshake-2026-09-22/lane6-live-battery-rerun.log. |
| IB-6 | canvas_item_bank_create_item | POST | /api/banks/{bank_id}/items | W | item-banks-sdk | live-proven | 2026-09-21: retargeted to the Item Banks SDK lane (transport/item_bank_sdk.py), ported from Meridian production's proven recipe: dynamic LTI tool resolution, course-scoped banks.build launch, quiz-api host derived per tenant, item fields nested under top-level "item". The old canvas-origin path 500'd. 2026-09-21: LIVE-PROVEN through the Chromium SDK lane: item_create 201, item 11244176 in disposable bank 4062 (evidence/item_bank_sdk_battery_MORROW-SDK-PROOF-20260921T220016Z.json). Full lifecycle with cleanup: attached via bank_entries 201 (entry 82714), entry removed 204, entries list absence count=0 before archive, bank archived 204, absent from bank list. |
| IB-7 | canvas_item_bank_delete_entry | DELETE | /api/banks/{bank_id}/bank_entries/{bank_entry_id} | W | item-banks-sdk | live-proven | 2026-09-21: LIVE-PROVEN through the Chromium SDK lane (transport/item_bank_sdk.py): the 22:01 UTC disposable lifecycle removed bank entry 82714 with DELETE 204, then the pre-archive entries-list readback returned 200 with count=0 and the entry absent (terminal absence evidence). Evidence: proof-battery/evidence/item_bank_sdk_battery_MORROW-SDK-PROOF-20260921T220016Z.json. This is the provider's actual item-removal route; the literal /items/{item_id} DELETE (IB-19) 404s on the provider and stays unproven. History: the earlier 2026-09-21 Chromium write battery failed with no anchor (item create 500'd on the old canvas-origin path); that lane is superseded by the SDK lane. |
| IB-8 | canvas_item_bank_delete_quiz_bank_entry | DELETE | /api/quizzes/{builder_quiz_id}/quiz_entries/{quiz_entry_id} | W | quiz-api-token | evidence-hold | Wave 2 (W2E): all quiz_entries routes -> 401 under the banks.build scope (list, attach entry, attach bank, delete); the scope has no policy for quiz_entries. Requires a different authorization scope. Quiz 506477 untouched. Held 2026-09-21: credential path rewritten (provision/launch_driver.py exists and is integrated into dispatch/executor.py); no live battery has proven the path; refused on every tenant until one does. 2026-09-21 Chromium write battery BLOCKED: confirmed 401 (scope has no quiz_entries policy); hold stands. |
| IB-9 | canvas_item_bank_get_bank | GET | /api/banks/{bank_id} | R | item-banks-sdk | live-proven | DEPLOY.md Fix A: bank 4017 read op 92246094-969d-4f65-80d1-69c180563285; readbacks of 4037/4040/4041 with title match Proof lane: quiz-api-token 2026-09-20 only. Not proven through the Chromium lane. 2026-09-21: executor Chromium lane now egresses this path via transport/item_bank_sdk.py (same banks.build mechanism the batteries proved); executor-pipeline live proof 2026-09-22 (Lane 6 live battery): GET 200 bank 2934, title '06.02 CHEST 213' matched. 2026-09-22 Lane 6 live battery: executor-pipeline live proof through dispatch/executor.py + transport/item_bank_sdk.py (course 89585, disposable objects, full cleanup; evidence ~/workspace/audits/earthshake-2026-09-22/lane6-live-battery.log). |
| IB-10 | canvas_item_bank_get_entry | GET | /api/banks/{bank_id}/bank_entries/{bank_entry_id} | R | item-banks-sdk | live-proven | Wave 1: entry 82699 read 200 with exact nested item; Wave 2: entries 82700/82701 read 200. Entry GET is the working item read path (direct item GET is provider-anomalous, see canvas_item_bank_get_item). Proof lane: quiz-api-token 2026-09-20 only. Not proven through the Chromium lane. 2026-09-21: executor Chromium lane now egresses this path via transport/item_bank_sdk.py (same banks.build mechanism the batteries proved); executor-pipeline live proof 2026-09-22 (Lane 6 live battery): GET 200 entry 82774 with the updated item_body (rename_match). 2026-09-22 Lane 6 live battery: executor-pipeline live proof through dispatch/executor.py + transport/item_bank_sdk.py (course 89585, disposable objects, full cleanup; evidence ~/workspace/audits/earthshake-2026-09-22/lane6-live-battery.log). Independently re-proven 2026-09-22 by the Lane 6 rerun (31/31 checks, EXIT=0): disposable bank 4078, item 11269650, entry 82776, share 39208; entry deleted 204, share unshared, bank archived 204 with absence verified, zero title leftovers. Evidence: ~/workspace/audits/earthshake-2026-09-22/lane6-live-battery-rerun.log. |
| IB-11 | canvas_item_bank_get_item | GET | /api/banks/{bank_id}/items/{item_id} | R | item-banks-sdk | pending | 2026-09-21: retargeted to the Item Banks SDK lane (transport/item_bank_sdk.py), ported from Meridian production's proven recipe. 2026-09-21: the SDK lane answered 404 on live items (11244173 unattached; 11244175 and 11244176 attached) - provider-anomalous confirmed on the Chromium lane, same as the old lanes (404 on existing items 11242724/11242015). Entry GET (IB-10) remains the working item read path. Status stays pending: the route is unproven because the provider does not serve it. |
| IB-12 | canvas_item_bank_list_banks | GET | /api/banks | R | item-banks-sdk | live-proven | item_bank_battery_results.json baseline_list: 11 banks; deploy smoke list before/after (bank 4041 absent after archive) Proof lane: quiz-api-token 2026-09-20 only. Not proven through the Chromium lane. 2026-09-21: executor Chromium lane now egresses this path via transport/item_bank_sdk.py (same banks.build mechanism the batteries proved); executor-pipeline live proof 2026-09-22 (Lane 6 live battery): GET 200, 50 banks listed. 2026-09-22 Lane 6 live battery: executor-pipeline live proof through dispatch/executor.py + transport/item_bank_sdk.py (course 89585, disposable objects, full cleanup; evidence ~/workspace/audits/earthshake-2026-09-22/lane6-live-battery.log). |
| IB-13 | canvas_item_bank_list_entries | GET | /api/banks/{bank_id}/bank_entries | R | item-banks-sdk | live-proven | item_bank_battery_results.json src_entries_scan bank 4017 (entry 82658); entries_readback bank 4037 entry_count 1 Proof lane: quiz-api-token 2026-09-20 only. Not proven through the Chromium lane. 2026-09-21: executor Chromium lane now egresses this path via transport/item_bank_sdk.py (same banks.build mechanism the batteries proved); executor-pipeline live proof 2026-09-22 (Lane 6 live battery): GET 200, 12 entries on anchor bank 2934. 2026-09-22 Lane 6 live battery: executor-pipeline live proof through dispatch/executor.py + transport/item_bank_sdk.py (course 89585, disposable objects, full cleanup; evidence ~/workspace/audits/earthshake-2026-09-22/lane6-live-battery.log). |
| IB-14 | canvas_item_bank_list_quiz_draws | GET | /api/quizzes/{builder_quiz_id}/quiz_entries | R | quiz-api-token | evidence-hold | Wave 2 (W2E): all quiz_entries routes -> 401 under the banks.build scope (list, attach entry, attach bank, delete); the scope has no policy for quiz_entries. Requires a different authorization scope. Quiz 506477 untouched. Held 2026-09-21: credential path rewritten (provision/launch_driver.py exists and is integrated into dispatch/executor.py); no live battery has proven the path; refused on every tenant until one does. 2026-09-21 Chromium write battery BLOCKED: confirmed 401 (scope has no quiz_entries policy); hold stands. |
| IB-15 | canvas_item_bank_list_shares | GET | /api/banks/{bank_id}/shared_banks | R | item-banks-sdk | live-proven | Wave 1/2: GET /api/banks/{bank}/shared_banks HTTP 200 on banks 4042/4044; archived-bank share inspection 401s (scope has no policy for archived shares). Proof lane: quiz-api-token 2026-09-20 only. Not proven through the Chromium lane. 2026-09-21: executor Chromium lane now egresses this path via transport/item_bank_sdk.py (same banks.build mechanism the batteries proved); executor-pipeline live proof 2026-09-22 (Lane 6 live battery): GET 200 shared_banks on anchor bank 2934. 2026-09-22 Lane 6 live battery: executor-pipeline live proof through dispatch/executor.py + transport/item_bank_sdk.py (course 89585, disposable objects, full cleanup; evidence ~/workspace/audits/earthshake-2026-09-22/lane6-live-battery.log). |
| IB-16 | canvas_item_bank_rename_bank | PATCH | /api/banks/{bank_id} | W | item-banks-sdk | live-proven | Wave 1: bank 4042 PATCH rename HTTP 200. 2026-09-21 Chromium write battery: PATCH 200 rename 4053; readback title_match. 2026-09-21: executor Chromium lane now egresses this path via transport/item_bank_sdk.py (same banks.build mechanism the batteries proved); executor-pipeline live proof 2026-09-22 (Lane 6 live battery): PATCH 200 rename bank 4076; readback title matched. 2026-09-22 Lane 6 live battery: executor-pipeline live proof through dispatch/executor.py + transport/item_bank_sdk.py (course 89585, disposable objects, full cleanup; evidence ~/workspace/audits/earthshake-2026-09-22/lane6-live-battery.log). Independently re-proven 2026-09-22 by the Lane 6 rerun (31/31 checks, EXIT=0): disposable bank 4078, item 11269650, entry 82776, share 39208; entry deleted 204, share unshared, bank archived 204 with absence verified, zero title leftovers. Evidence: ~/workspace/audits/earthshake-2026-09-22/lane6-live-battery-rerun.log. |
| IB-17 | canvas_item_bank_share_bank | POST | /api/banks/{bank_id}/shared_banks | W | item-banks-sdk | live-proven | Wave 1: bank 4042 share 38922 (course 89585) HTTP 201; Wave 2: bank 4044 share 38924 HTTP 201. Unshare: no unshare via DELETE (DELETE /api/banks/{bank}/shared_banks/{id} -> 404); unshare is PATCH /api/banks/{bank}/shared_banks/{id} with {shared_bank:{permission:"removed_access"}}. 2026-09-21 Chromium write battery: POST 201 share 38934; PATCH 200 unshare; list verify clean. 2026-09-21: executor Chromium lane now egresses this path via transport/item_bank_sdk.py (same banks.build mechanism the batteries proved); executor-pipeline live proof 2026-09-22 (Lane 6 live battery): POST 201 share 39206 (course 89585); share list showed it. 2026-09-22 Lane 6 live battery: executor-pipeline live proof through dispatch/executor.py + transport/item_bank_sdk.py (course 89585, disposable objects, full cleanup; evidence ~/workspace/audits/earthshake-2026-09-22/lane6-live-battery.log). Independently re-proven 2026-09-22 by the Lane 6 rerun (31/31 checks, EXIT=0): disposable bank 4078, item 11269650, entry 82776, share 39208; entry deleted 204, share unshared, bank archived 204 with absence verified, zero title leftovers. Evidence: ~/workspace/audits/earthshake-2026-09-22/lane6-live-battery-rerun.log. |
| IB-18 | canvas_item_bank_update_item | PATCH | /api/banks/{bank_id}/items/{item_id} | W | item-banks-sdk | live-proven | 2026-09-21: retargeted to the Item Banks SDK lane (transport/item_bank_sdk.py), ported from Meridian production's proven recipe: PATCH (never PUT), fields nested under top-level "item". The old canvas-origin path had no anchor (item create 500'd). 2026-09-21: LIVE-PROVEN through the Chromium SDK lane: PATCH 200 on attached item 11244176 (disposable bank 4062), entry GET readback 200 with the renamed item_body confirmed (rename_match). Note: the PATCH must run after the item is attached via bank_entries (unattached items 404). evidence/item_bank_sdk_battery_MORROW-SDK-PROOF-20260921T220016Z.json |
| IB-19 | canvas_item_bank_delete_item | DELETE | /api/banks/{bank_id}/items/{item_id} | W | item-banks-sdk | pending | 2026-09-21: new row. Item DELETE was never proven on any lane (Meridian production has no delete_item flow; its cleanup is bank delete/archive). 2026-09-21: the SDK lane answered 404 on the attached live item 11244176 (disposable bank 4062), so the route as defined stays unproven and is not claimed. The provider's actual item-removal route is DELETE /api/banks/{bank_id}/bank_entries/{entry_id}: 204 on entry 82714, entries list read 200 count=0 with the entry absent (pre-archive absence readback), bank archived 204, absent from bank list. evidence/item_bank_sdk_battery_MORROW-SDK-PROOF-20260921T220016Z.json  2026-09-22 Lane 6 exhaustive probe: DELETE /api/banks/{bank}/items/{item} answered 404 in all three attachment states on a live bank (unattached, attached as entry 82775, detached after entry DELETE 204) and on the three archived-bank residue items (4058/11244173, 4062/11244176, 4042/11242724); GET /api/banks/{bank}/items (list route) also 404s. The provider serves no item-delete route: the supported item-removal lifecycle is bank-entry DELETE (204, live-proven) plus bank archive (204, live-proven). Items remaining inside archived banks are invisible to educators (absent from the bank list). Evidence: ~/workspace/audits/earthshake-2026-09-22/lane6-probe-item-delete-evidence.json. |
| IB-20 | canvas_item_bank_unshare_bank | PATCH | /api/banks/{bank_id}/shared_banks/{shared_bank_id} | W | item-banks-sdk | live-proven | 2026-09-21 Chromium write battery: unshare proven via PATCH /api/banks/{bank_id}/shared_banks/{shared_bank_id} with {shared_bank:{permission:"removed_access"}} (share 38934, PATCH 200, list verified clean). DELETE on the share route 404s; that DELETE reading is retired as the unshare statement (W3-P2-20). 2026-09-21: executor Chromium lane now egresses this path via transport/item_bank_sdk.py (same banks.build mechanism the batteries proved); executor-pipeline live proof 2026-09-22 (Lane 6 live battery): PATCH 200 unshare share 39206; share list verified clean. 2026-09-22 Lane 6 live battery: executor-pipeline live proof through dispatch/executor.py + transport/item_bank_sdk.py (course 89585, disposable objects, full cleanup; evidence ~/workspace/audits/earthshake-2026-09-22/lane6-live-battery.log). Independently re-proven 2026-09-22 by the Lane 6 rerun (31/31 checks, EXIT=0): disposable bank 4078, item 11269650, entry 82776, share 39208; entry deleted 204, share unshared, bank archived 204 with absence verified, zero title leftovers. Evidence: ~/workspace/audits/earthshake-2026-09-22/lane6-live-battery-rerun.log. |

## New Quiz creation sequence (quiz-lti native-launch lane)

The proven no-PAT New Quiz creation path (proofs/quiz-lane-unblock.md, 2026-09-20, course 89585). This is the lane library sequence; productizing it as Muse ops is still pending.

| # | Step | Status | Evidence |
|---|------|--------|----------|
| NQS-1 | Create Canvas assignment (external_tool, New Quizzes tool 54065) | live-proven | assignment 4045366, HTTP 201 (proofs/quiz-lane-unblock.md) |
| NQS-2 | Native launch (POST quiz-lti /api/native/launch) | live-proven | quiz-api assignment 507872 auto-provisioned, HTTP 200 |
| NQS-3 | Assignment session (GET quiz-lti /api/assignments/{id}?scope=quiz.build) | live-proven | quiz-api quiz 506477 auto-created, HTTP 200 |
| NQS-4 | Quiz read (GET quiz-api /api/quizzes/506477) | live-proven | HTTP 200, title matched |
| NQS-5 | Quiz edit (PATCH quiz-api /api/quizzes/506477) | live-proven | title plus shuffle_questions confirmed via GET |
| NQS-6 | Quiz delete (DELETE quiz-api /api/quizzes/{id}) | live-proven | quiz 4045369 deleted via the quiz API, HTTP 200; quiz GET 404, assignment GET 404, assignment absent from the course list, no orphan. CORRECTION 2026-09-20: the old 401/orphan-506477 reading was wrong; that orphan came from deleting assignment 4045366 through the Canvas assignment endpoint first. Correct lifecycle: always delete a New Quiz through the quiz API, never through the assignment endpoint. Orphan 506477 remains Braden's call. |
| NQS-7 | Quiz archive (PATCH status=archived) | unsupported | No whole-quiz archive action in the served tool bundle; battery2 fallback failed |
| NQS-8 | Canvas assignment delete plus verify-gone | live-proven | assignment 4045366 deleted via API, GET returned 404 |
| NQS-9 | Quiz settings read plus full-block PATCH | live-proven | quiz 4045369: settings read returned 13 keys; full-block PATCH changed only shuffle_questions (HTTP 200); readback preserved the other 12 |
| NQS-10 | Quiz item create/read/list/delete | live-proven | items 11028911/11028912 created (HTTP 200), read 200, listed, deleted; final item count 0 |
| NQS-11 | Quiz item rename via item.entry | live-proven | item 11028912 renamed through {item: {entry: {...}}} with readback match. Payload contract: partial {item: {title}} update -> HTTP 400; entry-nested shape is required. |

Note: battery2.py also covered the accessibility-relevant check (title non-empty, instructions key present, status present, quiz_type present). Pre-existing proof objects 4045358, 4045364, 4045365 and quiz 506400 were left untouched by the lane.

## Moodle course-level operations

Reference: the desktop Moodle browser catalog (250 operations). Live proof: proofs/moodle-lane-proof.md (2026-09-20, sandbox.moodledemo.net, Moodle 5.2, teacher demo account). The sandbox resets hourly; production SSO variants and session lifetimes are unproven (proof section 6). Context 2026-09-21: the Moodle read battery (moodle-read-battery/MATRIX.md) enumerated 352 registered external functions on sandbox.moodledemo.net (Moodle 5.2.3): 110 PROVEN / 65 FAILED / 177 BLOCKED over AJAX. Morrow for Muse includes the separate Moodle session lane. Each M-row keeps its operation-specific evidence status; this battery is context only, not per-op proof.

### moodle.core_backup (2)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-1 | moodle_get_backup_progress | moodle.ajax.core_backup.async_progress.backup.read.v1 | R | moodle-ajax | pending |  |
| M-2 | moodle_get_restore_progress | moodle.ajax.core_backup.async_progress.restore.read.v1 | R | moodle-ajax | pending |  |

### moodle.core_calendar (6)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-3 | moodle_get_course_dates | moodle.ajax.core_calendar.course_dates.read.v1 | R | moodle-ajax | pending |  |
| M-4 | moodle_list_course_events | moodle.ajax.core_calendar.course_events.read.v1 | R | moodle-ajax | pending |  |
| M-5 | moodle_get_event | moodle.ajax.core_calendar.event.read.v1 | R | moodle-ajax | pending |  |
| M-6 | moodle_create_course_event | moodle.ajax.core_calendar.event_create.write.v1 | W | moodle-ajax | pending |  |
| M-7 | moodle_delete_event | moodle.ajax.core_calendar.event_delete.write.v1 | W | moodle-ajax | pending |  |
| M-8 | moodle_update_event | moodle.ajax.core_calendar.event_update.write.v1 | W | moodle-ajax | pending |  |

### moodle.core_course_get_enrolled_courses_by_timeline_classification (1)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-9 | moodle_list_my_courses | moodle.ajax.core_course_get_enrolled_courses_by_timeline_classification.v1 | R | moodle-ajax | live-proven | moodle-lane-proof.md section 4: course 2 'My first course', 2 enrolled (moodle.courses.read, AJAX) |

### moodle.core_courseformat_get_state (3)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-10 | moodle_list_assignments | moodle.ajax.core_courseformat_get_state.assignments.v1 | R | moodle-ajax | pending |  |
| M-11 | moodle_list_quizzes | moodle.ajax.core_courseformat_get_state.quizzes.v1 | R | moodle-ajax | pending |  |
| M-12 | moodle_get_contents | moodle.ajax.core_courseformat_get_state.v1 | R | moodle-ajax | pending |  |

### moodle.core_courseformat_update_course (12)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-13 | moodle_delete_activity | moodle.ajax.core_courseformat_update_course.cm_delete.v1 | W | moodle-ajax | pending |  |
| M-14 | moodle_duplicate_activity | moodle.ajax.core_courseformat_update_course.cm_duplicate.v1 | W | moodle-ajax | pending |  |
| M-15 | moodle_set_activity_group_mode | moodle.ajax.core_courseformat_update_course.cm_groupmode.v1 | W | moodle-ajax | pending |  |
| M-16 | moodle_hide_activity | moodle.ajax.core_courseformat_update_course.cm_hide.v1 | W | moodle-ajax | pending |  |
| M-17 | moodle_move_activity | moodle.ajax.core_courseformat_update_course.cm_move.v1 | W | moodle-ajax | pending |  |
| M-18 | moodle_move_activity_to_position | moodle.ajax.core_courseformat_update_course.cm_move_to_position.v1 | W | moodle-ajax | pending |  |
| M-19 | moodle_show_activity | moodle.ajax.core_courseformat_update_course.cm_show.v1 | W | moodle-ajax | pending |  |
| M-20 | moodle_create_section | moodle.ajax.core_courseformat_update_course.section_add.v1 | W | moodle-ajax | pending |  |
| M-21 | moodle_delete_section | moodle.ajax.core_courseformat_update_course.section_delete.v1 | W | moodle-ajax | pending |  |
| M-22 | moodle_hide_section | moodle.ajax.core_courseformat_update_course.section_hide.v1 | W | moodle-ajax | pending |  |
| M-23 | moodle_move_section | moodle.ajax.core_courseformat_update_course.section_move_after.v1 | W | moodle-ajax | pending |  |
| M-24 | moodle_show_section | moodle.ajax.core_courseformat_update_course.section_show.v1 | W | moodle-ajax | pending |  |

### moodle.core_update_inplace_editable (2)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-25 | moodle_assign_role | moodle.ajax.core_update_inplace_editable.user_roles.assign.v1 | W | moodle-ajax | pending |  |
| M-26 | moodle_remove_role | moodle.ajax.core_update_inplace_editable.user_roles.remove.v1 | W | moodle-ajax | pending |  |

### moodle.admin (2)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-27 | moodle_get_role_definitions | moodle.form.admin.role_definitions.read.v1 | R | moodle-form | pending |  |
| M-28 | moodle_get_site_inventory | moodle.form.admin.site_inventory.read.v1 | R | moodle-form | pending |  |

### moodle.assign (3)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-29 | moodle_get_assignment_feedback | moodle.form.assign.feedback.read.v1 | R | moodle-form | pending |  |
| M-30 | moodle_get_assignment_submission | moodle.form.assign.submission.read.v1 | R | moodle-form | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| M-31 | moodle_get_assignment_submission_summary | moodle.form.assign.submissions.read.v1 | R | moodle-form | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### moodle.backup (5)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-32 | moodle_start_course_backup | moodle.form.backup.backup.course.write.v1 | W | moodle-form | pending |  |
| M-33 | moodle_copy_course | moodle.form.backup.copy.course.write.v1 | W | moodle-form | pending |  |
| M-34 | moodle_start_course_import | moodle.form.backup.import.course.write.v1 | W | moodle-form | pending |  |
| M-35 | moodle_start_course_restore | moodle.form.backup.restore.course.write.v1 | W | moodle-form | pending |  |
| M-36 | moodle_list_backup_files | moodle.form.backup.restorefile.index.read.v1 | R | moodle-form | pending |  |

### moodle.choice (3)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-37 | moodle_update_choice_option | moodle.form.choice.option.write.v1 | W | moodle-form | pending |  |
| M-38 | moodle_get_choice_options | moodle.form.choice.options.read.v1 | R | moodle-form | pending |  |
| M-39 | moodle_get_choice_response_summary | moodle.form.choice.response_summary.read.v1 | R | moodle-form | pending |  |

### moodle.course (110)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-40 | moodle_get_course_completion | moodle.form.course.completion.read.v1 | R | moodle-form | pending |  |
| M-41 | moodle_update_course_completion | moodle.form.course.completion.write.v1 | W | moodle-form | pending |  |
| M-42 | moodle_change_course_format | moodle.form.course.edit.format.write.v1 | W | moodle-form | pending |  |
| M-43 | moodle_get_course | moodle.form.course.edit.read.v1 | R | moodle-form | pending |  |
| M-44 | moodle_get_course_settings | moodle.form.course.edit.settings.read.v1 | R | moodle-form | pending |  |
| M-45 | moodle_update_course_settings | moodle.form.course.edit.settings.write.v1 | W | moodle-form | pending |  |
| M-46 | moodle_get_course_summary | moodle.form.course.edit.summary.read.v1 | R | moodle-form | pending |  |
| M-47 | moodle_update_course_summary | moodle.form.course.edit.summary.write.v1 | W | moodle-form | pending |  |
| M-48 | moodle_hide_course | moodle.form.course.edit.visibility.hide.v1 | W | moodle-form | pending |  |
| M-49 | moodle_show_course | moodle.form.course.edit.visibility.write.v1 | W | moodle-form | pending |  |
| M-50 | moodle_get_section | moodle.form.course.editsection.read.v1 | R | moodle-form | pending |  |
| M-51 | moodle_get_section_restrictions | moodle.form.course.editsection.restrictions.read.v1 | R | moodle-form | pending |  |
| M-52 | moodle_update_section_restrictions | moodle.form.course.editsection.restrictions.write.v1 | W | moodle-form | pending |  |
| M-53 | moodle_update_section | moodle.form.course.editsection.write.v1 | W | moodle-form | pending |  |
| M-54 | moodle_get_assignment_creation_form | moodle.form.course.modedit.assign.create.read.v1 | R | moodle-form | pending |  |
| M-55 | moodle_create_assignment | moodle.form.course.modedit.assign.create.write.v1 | W | moodle-form | pending |  |
| M-56 | moodle_get_assignment | moodle.form.course.modedit.assign.read.v1 | R | moodle-form | pending |  |
| M-57 | moodle_update_assignment | moodle.form.course.modedit.assign.write.v1 | W | moodle-form | pending |  |
| M-58 | moodle_get_bigbluebuttonbn_creation_form | moodle.form.course.modedit.bigbluebuttonbn.create.read.v1 | R | moodle-form | pending |  |
| M-59 | moodle_create_bigbluebuttonbn | moodle.form.course.modedit.bigbluebuttonbn.create.write.v1 | W | moodle-form | pending |  |
| M-60 | moodle_get_bigbluebuttonbn | moodle.form.course.modedit.bigbluebuttonbn.read.v1 | R | moodle-form | pending |  |
| M-61 | moodle_update_bigbluebuttonbn | moodle.form.course.modedit.bigbluebuttonbn.write.v1 | W | moodle-form | pending |  |
| M-62 | moodle_get_book_creation_form | moodle.form.course.modedit.book.create.read.v1 | R | moodle-form | pending |  |
| M-63 | moodle_create_book | moodle.form.course.modedit.book.create.write.v1 | W | moodle-form | pending |  |
| M-64 | moodle_get_book | moodle.form.course.modedit.book.read.v1 | R | moodle-form | pending |  |
| M-65 | moodle_update_book | moodle.form.course.modedit.book.write.v1 | W | moodle-form | pending |  |
| M-66 | moodle_get_choice_creation_form | moodle.form.course.modedit.choice.create.read.v1 | R | moodle-form | pending |  |
| M-67 | moodle_create_choice | moodle.form.course.modedit.choice.create.write.v1 | W | moodle-form | pending |  |
| M-68 | moodle_get_choice | moodle.form.course.modedit.choice.read.v1 | R | moodle-form | pending |  |
| M-69 | moodle_update_choice | moodle.form.course.modedit.choice.write.v1 | W | moodle-form | pending |  |
| M-70 | moodle_get_activity_completion | moodle.form.course.modedit.completion.read.v1 | R | moodle-form | pending |  |
| M-71 | moodle_update_activity_completion | moodle.form.course.modedit.completion.write.v1 | W | moodle-form | pending |  |
| M-72 | moodle_get_database_creation_form | moodle.form.course.modedit.data.create.read.v1 | R | moodle-form | pending |  |
| M-73 | moodle_create_database | moodle.form.course.modedit.data.create.write.v1 | W | moodle-form | pending |  |
| M-74 | moodle_get_database | moodle.form.course.modedit.data.read.v1 | R | moodle-form | pending |  |
| M-75 | moodle_update_database | moodle.form.course.modedit.data.write.v1 | W | moodle-form | pending |  |
| M-76 | moodle_get_feedback_creation_form | moodle.form.course.modedit.feedback.create.read.v1 | R | moodle-form | pending |  |
| M-77 | moodle_create_feedback | moodle.form.course.modedit.feedback.create.write.v1 | W | moodle-form | pending |  |
| M-78 | moodle_get_feedback | moodle.form.course.modedit.feedback.read.v1 | R | moodle-form | pending |  |
| M-79 | moodle_update_feedback | moodle.form.course.modedit.feedback.write.v1 | W | moodle-form | pending |  |
| M-80 | moodle_get_folder_file_creation_form | moodle.form.course.modedit.folder.file.create.read.v1 | R | moodle-form | pending |  |
| M-81 | moodle_create_folder_file | moodle.form.course.modedit.folder.file.create.write.v1 | W | moodle-form | pending |  |
| M-82 | moodle_add_folder_files | moodle.form.course.modedit.folder.files.add.write.v1 | W | moodle-form | pending |  |
| M-83 | moodle_get_folder_files | moodle.form.course.modedit.folder.files.read.v1 | R | moodle-form | pending |  |
| M-84 | moodle_get_folder | moodle.form.course.modedit.folder.read.v1 | R | moodle-form | pending |  |
| M-85 | moodle_create_folder_subfolder | moodle.form.course.modedit.folder.subfolder.create.write.v1 | W | moodle-form | pending |  |
| M-86 | moodle_get_forum_creation_form | moodle.form.course.modedit.forum.create.read.v1 | R | moodle-form | pending |  |
| M-87 | moodle_create_forum | moodle.form.course.modedit.forum.create.write.v1 | W | moodle-form | pending |  |
| M-88 | moodle_get_forum | moodle.form.course.modedit.forum.read.v1 | R | moodle-form | pending |  |
| M-89 | moodle_update_forum | moodle.form.course.modedit.forum.write.v1 | W | moodle-form | pending |  |
| M-90 | moodle_get_glossary_creation_form | moodle.form.course.modedit.glossary.create.read.v1 | R | moodle-form | pending |  |
| M-91 | moodle_create_glossary | moodle.form.course.modedit.glossary.create.write.v1 | W | moodle-form | pending |  |
| M-92 | moodle_get_glossary | moodle.form.course.modedit.glossary.read.v1 | R | moodle-form | pending |  |
| M-93 | moodle_update_glossary | moodle.form.course.modedit.glossary.write.v1 | W | moodle-form | pending |  |
| M-94 | moodle_get_h5pactivity_creation_form | moodle.form.course.modedit.h5pactivity.create.read.v1 | R | moodle-form | pending |  |
| M-95 | moodle_create_h5pactivity | moodle.form.course.modedit.h5pactivity.create.write.v1 | W | moodle-form | pending |  |
| M-96 | moodle_replace_h5pactivity_package | moodle.form.course.modedit.h5pactivity.package.replace.write.v1 | W | moodle-form | pending |  |
| M-97 | moodle_get_h5pactivity | moodle.form.course.modedit.h5pactivity.read.v1 | R | moodle-form | pending |  |
| M-98 | moodle_update_h5pactivity | moodle.form.course.modedit.h5pactivity.write.v1 | W | moodle-form | pending |  |
| M-99 | moodle_get_imscp_package_creation_form | moodle.form.course.modedit.imscp.package.create.read.v1 | R | moodle-form | pending |  |
| M-100 | moodle_create_imscp_package | moodle.form.course.modedit.imscp.package.create.write.v1 | W | moodle-form | pending |  |
| M-101 | moodle_get_imscp | moodle.form.course.modedit.imscp.read.v1 | R | moodle-form | pending |  |
| M-102 | moodle_get_label_creation_form | moodle.form.course.modedit.label.create.read.v1 | R | moodle-form | pending |  |
| M-103 | moodle_create_label | moodle.form.course.modedit.label.create.write.v1 | W | moodle-form | pending |  |
| M-104 | moodle_get_label | moodle.form.course.modedit.label.read.v1 | R | moodle-form | pending |  |
| M-105 | moodle_update_label | moodle.form.course.modedit.label.write.v1 | W | moodle-form | pending |  |
| M-106 | moodle_get_lesson_creation_form | moodle.form.course.modedit.lesson.create.read.v1 | R | moodle-form | pending |  |
| M-107 | moodle_create_lesson | moodle.form.course.modedit.lesson.create.write.v1 | W | moodle-form | pending |  |
| M-108 | moodle_get_lesson | moodle.form.course.modedit.lesson.read.v1 | R | moodle-form | pending |  |
| M-109 | moodle_update_lesson | moodle.form.course.modedit.lesson.write.v1 | W | moodle-form | pending |  |
| M-110 | moodle_get_lti_creation_form | moodle.form.course.modedit.lti.create.read.v1 | R | moodle-form | pending |  |
| M-111 | moodle_create_lti | moodle.form.course.modedit.lti.create.write.v1 | W | moodle-form | pending |  |
| M-112 | moodle_get_lti | moodle.form.course.modedit.lti.read.v1 | R | moodle-form | pending |  |
| M-113 | moodle_update_lti | moodle.form.course.modedit.lti.write.v1 | W | moodle-form | pending |  |
| M-114 | moodle_get_page_creation_form | moodle.form.course.modedit.page.create.read.v1 | R | moodle-form | pending |  |
| M-115 | moodle_create_page | moodle.form.course.modedit.page.create.write.v1 | W | moodle-form | pending |  |
| M-116 | moodle_get_page | moodle.form.course.modedit.page.read.v1 | R | moodle-form | pending |  |
| M-117 | moodle_update_page | moodle.form.course.modedit.page.write.v1 | W | moodle-form | pending |  |
| M-118 | moodle_get_qbank_activity_creation_form | moodle.form.course.modedit.qbank.create.read.v1 | R | moodle-form | pending |  |
| M-119 | moodle_create_qbank_activity | moodle.form.course.modedit.qbank.create.write.v1 | W | moodle-form | pending |  |
| M-120 | moodle_get_qbank_activity | moodle.form.course.modedit.qbank.read.v1 | R | moodle-form | pending |  |
| M-121 | moodle_get_quiz_creation_form | moodle.form.course.modedit.quiz.create.read.v1 | R | moodle-form | pending |  |
| M-122 | moodle_create_quiz | moodle.form.course.modedit.quiz.create.write.v1 | W | moodle-form | pending |  |
| M-123 | moodle_get_quiz | moodle.form.course.modedit.quiz.read.v1 | R | moodle-form | pending |  |
| M-124 | moodle_update_quiz | moodle.form.course.modedit.quiz.write.v1 | W | moodle-form | pending |  |
| M-125 | moodle_get_resource_file_creation_form | moodle.form.course.modedit.resource.file.create.read.v1 | R | moodle-form | pending |  |
| M-126 | moodle_create_resource_file | moodle.form.course.modedit.resource.file.create.write.v1 | W | moodle-form | pending |  |
| M-127 | moodle_delete_resource_file | moodle.form.course.modedit.resource.file.delete.write.v1 | W | moodle-form | pending |  |
| M-128 | moodle_replace_resource_file | moodle.form.course.modedit.resource.file.replace.write.v1 | W | moodle-form | pending |  |
| M-129 | moodle_get_resource_files | moodle.form.course.modedit.resource.files.read.v1 | R | moodle-form | pending |  |
| M-130 | moodle_get_activity_restrictions | moodle.form.course.modedit.restrictions.read.v1 | R | moodle-form | pending |  |
| M-131 | moodle_update_activity_restrictions | moodle.form.course.modedit.restrictions.write.v1 | W | moodle-form | pending |  |
| M-132 | moodle_get_scorm_package_creation_form | moodle.form.course.modedit.scorm.package.create.read.v1 | R | moodle-form | pending |  |
| M-133 | moodle_create_scorm_package | moodle.form.course.modedit.scorm.package.create.write.v1 | W | moodle-form | pending |  |
| M-134 | moodle_replace_scorm_package | moodle.form.course.modedit.scorm.package.replace.write.v1 | W | moodle-form | pending |  |
| M-135 | moodle_get_scorm | moodle.form.course.modedit.scorm.read.v1 | R | moodle-form | pending |  |
| M-136 | moodle_update_scorm | moodle.form.course.modedit.scorm.write.v1 | W | moodle-form | pending |  |
| M-137 | moodle_create_subsection | moodle.form.course.modedit.subsection.create.write.v1 | W | moodle-form | pending |  |
| M-138 | moodle_get_url_creation_form | moodle.form.course.modedit.url.create.read.v1 | R | moodle-form | pending |  |
| M-139 | moodle_create_url | moodle.form.course.modedit.url.create.write.v1 | W | moodle-form | pending |  |
| M-140 | moodle_get_url | moodle.form.course.modedit.url.read.v1 | R | moodle-form | pending |  |
| M-141 | moodle_update_url | moodle.form.course.modedit.url.write.v1 | W | moodle-form | pending |  |
| M-142 | moodle_get_wiki_creation_form | moodle.form.course.modedit.wiki.create.read.v1 | R | moodle-form | pending |  |
| M-143 | moodle_create_wiki | moodle.form.course.modedit.wiki.create.write.v1 | W | moodle-form | pending |  |
| M-144 | moodle_get_wiki | moodle.form.course.modedit.wiki.read.v1 | R | moodle-form | pending |  |
| M-145 | moodle_update_wiki | moodle.form.course.modedit.wiki.write.v1 | W | moodle-form | pending |  |
| M-146 | moodle_get_workshop_creation_form | moodle.form.course.modedit.workshop.create.read.v1 | R | moodle-form | pending |  |
| M-147 | moodle_create_workshop | moodle.form.course.modedit.workshop.create.write.v1 | W | moodle-form | pending |  |
| M-148 | moodle_get_workshop | moodle.form.course.modedit.workshop.read.v1 | R | moodle-form | pending |  |
| M-149 | moodle_update_workshop | moodle.form.course.modedit.workshop.write.v1 | W | moodle-form | pending |  |

### moodle.data (4)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-150 | moodle_get_database_entry_summary | moodle.form.data.entry_summary.read.v1 | R | moodle-form | pending |  |
| M-151 | moodle_create_database_field | moodle.form.data.field.create.write.v1 | W | moodle-form | pending |  |
| M-152 | moodle_update_database_field | moodle.form.data.field.write.v1 | W | moodle-form | pending |  |
| M-153 | moodle_get_database_fields | moodle.form.data.fields.read.v1 | R | moodle-form | pending |  |

### moodle.enrol (6)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-154 | moodle_get_enrolment_methods | moodle.form.enrol.methods.read.v1 | R | moodle-form | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| M-155 | moodle_enrol_participant | moodle.form.enrol.participant.enrol.write.v1 | W | moodle-form | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| M-156 | moodle_get_participant_enrolment | moodle.form.enrol.participant.read.v1 | R | moodle-form | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| M-157 | moodle_suspend_participant | moodle.form.enrol.participant.suspend.write.v1 | W | moodle-form | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| M-158 | moodle_unenrol_participant | moodle.form.enrol.participant.unenrol.write.v1 | W | moodle-form | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| M-159 | moodle_get_course_participants | moodle.form.enrol.participants.read.v1 | R | moodle-form | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### moodle.feedback (4)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-160 | moodle_create_feedback_item | moodle.form.feedback.item.create.write.v1 | W | moodle-form | pending |  |
| M-161 | moodle_update_feedback_item | moodle.form.feedback.item.write.v1 | W | moodle-form | pending |  |
| M-162 | moodle_get_feedback_items | moodle.form.feedback.items.read.v1 | R | moodle-form | pending |  |
| M-163 | moodle_get_feedback_response_summary | moodle.form.feedback.response_summary.read.v1 | R | moodle-form | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### moodle.forum (7)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-164 | moodle_get_forum_activity_summary | moodle.form.forum.activity_summary.read.v1 | R | moodle-form | pending |  |
| M-165 | moodle_create_forum_discussion | moodle.form.forum.discussion.create.write.v1 | W | moodle-form | live-proven | moodle-lane-proof.md section 4: discussion 2, post 2 created via form path, HTTP 200, frozen plan op 45cc4b25 (sandbox.moodledemo.net, Moodle 5.2) |
| M-166 | moodle_lock_forum_discussion | moodle.form.forum.discussion.lock.write.v1 | W | moodle-form | pending |  |
| M-167 | moodle_pin_forum_discussion | moodle.form.forum.discussion.pin.write.v1 | W | moodle-form | pending |  |
| M-168 | moodle_set_forum_subscription | moodle.form.forum.discussion.subscription.write.v1 | W | moodle-form | pending |  |
| M-169 | moodle_reply_to_forum_post | moodle.form.forum.post.reply.write.v1 | W | moodle-form | pending |  |
| M-170 | moodle_get_forum_post_target | moodle.form.forum.post_target.read.v1 | R | moodle-form | pending |  |

### moodle.glossary (4)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-171 | moodle_list_glossary_entries | moodle.form.glossary.entries.read.v1 | R | moodle-form | pending |  |
| M-172 | moodle_create_glossary_entry | moodle.form.glossary.entry.create.write.v1 | W | moodle-form | pending |  |
| M-173 | moodle_get_glossary_entry | moodle.form.glossary.entry.read.v1 | R | moodle-form | pending |  |
| M-174 | moodle_update_glossary_entry | moodle.form.glossary.entry.update.write.v1 | W | moodle-form | pending |  |

### moodle.grade (12)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-175 | moodle_get_grade_outcomes | moodle.form.grade.outcome.index.read.v1 | R | moodle-form | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| M-176 | moodle_get_learner_grade_report | moodle.form.grade.report.learner.read.v1 | R | moodle-form | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| M-177 | moodle_get_grade_report_summary | moodle.form.grade.report.summary.read.v1 | R | moodle-form | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| M-178 | moodle_get_grade_scales | moodle.form.grade.scale.index.read.v1 | R | moodle-form | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| M-179 | moodle_get_gradebook_settings | moodle.form.grade.settings.index.read.v1 | R | moodle-form | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| M-180 | moodle_get_grade_category | moodle.form.grade.tree.category.read.v1 | R | moodle-form | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| M-181 | moodle_update_grade_category_settings | moodle.form.grade.tree.category.settings.write.v1 | W | moodle-form | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| M-182 | moodle_update_grade_category | moodle.form.grade.tree.category.write.v1 | W | moodle-form | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| M-183 | moodle_get_gradebook_setup | moodle.form.grade.tree.index.read.v1 | R | moodle-form | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| M-184 | moodle_get_grade_item | moodle.form.grade.tree.item.read.v1 | R | moodle-form | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| M-185 | moodle_update_grade_item_settings | moodle.form.grade.tree.item.settings.write.v1 | W | moodle-form | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| M-186 | moodle_update_grade_item | moodle.form.grade.tree.item.write.v1 | W | moodle-form | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### moodle.group (7)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-187 | moodle_create_group | moodle.form.group.create.v1 | W | moodle-form | pending |  |
| M-188 | moodle_delete_group | moodle.form.group.delete.v1 | W | moodle-form | pending |  |
| M-189 | moodle_add_group_member | moodle.form.group.member.add.v1 | W | moodle-form | pending |  |
| M-190 | moodle_remove_group_member | moodle.form.group.member.remove.v1 | W | moodle-form | pending |  |
| M-191 | moodle_update_group | moodle.form.group.update.v1 | W | moodle-form | pending |  |
| M-192 | moodle_get_course_groupings | moodle.page.group.groupings.read.v1 | R | moodle-form | pending |  |
| M-193 | moodle_get_course_groups | moodle.page.group.membership_map.read.v1 | R | moodle-form | pending |  |

### moodle.grouping (3)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-194 | moodle_create_grouping | moodle.form.grouping.create.v1 | W | moodle-form | pending |  |
| M-195 | moodle_set_grouping_groups | moodle.form.grouping.groups.set.v1 | W | moodle-form | pending |  |
| M-196 | moodle_update_grouping | moodle.form.grouping.update.v1 | W | moodle-form | pending |  |

### moodle.lesson (6)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-197 | moodle_create_lesson_page | moodle.form.lesson.page.create.v1 | W | moodle-form | pending |  |
| M-198 | moodle_delete_lesson_page | moodle.form.lesson.page.delete.v1 | W | moodle-form | pending |  |
| M-199 | moodle_move_lesson_page | moodle.form.lesson.page.move.v1 | W | moodle-form | pending |  |
| M-200 | moodle_get_lesson_page | moodle.form.lesson.page.read.v1 | R | moodle-form | pending |  |
| M-201 | moodle_update_lesson_page | moodle.form.lesson.page.update.v1 | W | moodle-form | pending |  |
| M-202 | moodle_list_lesson_pages | moodle.form.lesson.pages.read.v1 | R | moodle-form | pending |  |

### moodle.mod (24)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-203 | moodle_create_assignment_override | moodle.form.mod.assign.override.create.write.v1 | W | moodle-form | pending |  |
| M-204 | moodle_update_assignment_override | moodle.form.mod.assign.override.write.v1 | W | moodle-form | pending |  |
| M-205 | moodle_get_assignment_overrides | moodle.form.mod.assign.overrides.read.v1 | R | moodle-form | pending |  |
| M-206 | moodle_get_book_chapter_creation_form | moodle.form.mod.book.chapter.create.read.v1 | R | moodle-form | pending |  |
| M-207 | moodle_create_book_chapter | moodle.form.mod.book.chapter.create.write.v1 | W | moodle-form | pending |  |
| M-208 | moodle_delete_book_chapter | moodle.form.mod.book.chapter.delete.write.v1 | W | moodle-form | pending |  |
| M-209 | moodle_hide_book_chapter | moodle.form.mod.book.chapter.hide.write.v1 | W | moodle-form | pending |  |
| M-210 | moodle_move_book_chapter | moodle.form.mod.book.chapter.move.write.v1 | W | moodle-form | pending |  |
| M-211 | moodle_get_book_chapter | moodle.form.mod.book.chapter.read.v1 | R | moodle-form | pending |  |
| M-212 | moodle_show_book_chapter | moodle.form.mod.book.chapter.show.write.v1 | W | moodle-form | pending |  |
| M-213 | moodle_update_book_chapter | moodle.form.mod.book.chapter.write.v1 | W | moodle-form | pending |  |
| M-214 | moodle_list_book_chapters | moodle.form.mod.book.chapters.read.v1 | R | moodle-form | pending |  |
| M-215 | moodle_get_forum_posts | moodle.form.mod.forum.export.read.v1 | R | moodle-form | pending |  |
| M-216 | moodle_list_quiz_questions | moodle.form.mod.quiz.edit.read.v1 | R | moodle-form | pending |  |
| M-217 | moodle_set_quiz_slot_mark | moodle.form.mod.quiz.edit.slot.maxmark.write.v1 | W | moodle-form | pending |  |
| M-218 | moodle_reorder_quiz_slot | moodle.form.mod.quiz.edit.slot.move.write.v1 | W | moodle-form | pending |  |
| M-219 | moodle_set_quiz_page_break | moodle.form.mod.quiz.edit.slot.pagebreak.write.v1 | W | moodle-form | pending |  |
| M-220 | moodle_remove_quiz_slot | moodle.form.mod.quiz.edit.slot.remove.write.v1 | W | moodle-form | pending |  |
| M-221 | moodle_get_quiz_structure | moodle.form.mod.quiz.edit.structure.read.v1 | R | moodle-form | pending |  |
| M-222 | moodle_create_quiz_override | moodle.form.mod.quiz.override.create.write.v1 | W | moodle-form | pending |  |
| M-223 | moodle_update_quiz_override | moodle.form.mod.quiz.override.write.v1 | W | moodle-form | pending |  |
| M-224 | moodle_get_quiz_overrides | moodle.form.mod.quiz.overrides.read.v1 | R | moodle-form | pending |  |
| M-225 | moodle_get_qbank_quiz_slot_plan | moodle.form.mod.quiz.qbank_question.add.read.v1 | R | moodle-form | pending |  |
| M-226 | moodle_add_qbank_question_to_quiz | moodle.form.mod.quiz.qbank_question.add.write.v1 | W | moodle-form | pending |  |

### moodle.question (6)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-227 | moodle_realize_qbank_default_category | moodle.form.question.bank.default_category.realize.write.v1 | W | moodle-form | pending |  |
| M-228 | moodle_get_qbank_question_creation_form | moodle.form.question.bank.editquestion.create.read.v1 | R | moodle-form | pending |  |
| M-229 | moodle_create_qbank_question | moodle.form.question.bank.editquestion.create.write.v1 | W | moodle-form | pending |  |
| M-230 | moodle_get_quiz_question | moodle.form.question.bank.editquestion.read.v1 | R | moodle-form | pending |  |
| M-231 | moodle_get_question_bank_filter_inventory | moodle.form.question.bank.filter.inventory.read.v1 | R | moodle-form | pending |  |
| M-232 | moodle_get_question_bank_impact_scope | moodle.form.question.bank.impact_scope.read.v1 | R | moodle-form | pending |  |

### moodle.quiz (4)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-233 | moodle_get_quiz_attempt | moodle.form.quiz.attempt_detail.read.v1 | R | moodle-form | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| M-234 | moodle_get_quiz_attempt_summary | moodle.form.quiz.attempt_summary.read.v1 | R | moodle-form | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| M-235 | moodle_get_quiz_manual_grading_queue | moodle.form.quiz.manual_grading_queue.read.v1 | R | moodle-form | pending |  |
| M-236 | moodle_get_quiz_regrade_report | moodle.form.quiz.regrade_report.read.v1 | R | moodle-form | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### moodle.report (5)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-237 | moodle_get_course_activity_report | moodle.form.report.activity.read.v1 | R | moodle-form | pending |  |
| M-238 | moodle_get_course_completion_report | moodle.form.report.completion.read.v1 | R | moodle-form | pending |  |
| M-239 | moodle_get_course_dates_report | moodle.form.report.dates.read.v1 | R | moodle-form | pending |  |
| M-240 | moodle_get_course_log_summary | moodle.form.report.log_summary.read.v1 | R | moodle-form | pending |  |
| M-241 | moodle_get_course_participation_report | moodle.form.report.participation.read.v1 | R | moodle-form | pending |  |

### moodle.scorm (2)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-242 | moodle_get_scorm_attempt_summary | moodle.form.scorm.attempt_summary.read.v1 | R | moodle-form | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |
| M-243 | moodle_get_scorm_learner_report | moodle.form.scorm.learner_report.read.v1 | R | moodle-form | pending |  |

### moodle.wiki (3)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-244 | moodle_get_wiki_page | moodle.form.wiki.page.read.v1 | R | moodle-form | pending |  |
| M-245 | moodle_update_wiki_page | moodle.form.wiki.page.update.write.v1 | W | moodle-form | pending |  |
| M-246 | moodle_list_wiki_pages | moodle.form.wiki.pages.read.v1 | R | moodle-form | pending |  |

### moodle.workshop (1)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-247 | moodle_get_workshop_phase | moodle.form.workshop.phase.read.v1 | R | moodle-form | pending |  |

### moodle.participants_table (1)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-248 | moodle_get_course_participant_roster | moodle.native.participants_table.privacy_roster.v1 | R | moodle-form | pending [LEARNER-DATA] | GATED: not live-tested until learner tokenization lands |

### moodle.subsection (2)

| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |
|---|------|-----|----|-----------|--------|------------------|
| M-249 | moodle_list_subsection_contents | moodle.state.subsection.contents.read.v1 | R | moodle-form | pending |  |
| M-250 | moodle_get_subsection | moodle.state.subsection.read.v1 | R | moodle-form | pending |  |

### Moodle lane-level rows (proven outside the 250-op catalog)

| Tool | Status | Evidence |
|------|--------|----------|
| moodle.principal.read (core_user_get_users_by_field, AJAX) | live-proven | moodle-lane-proof.md section 2: teacher id 3, username teacher, fullname Terri Teacher; sesskey 10 chars, stable |
| moodle.forum.discover (form path) | live-proven | moodle-lane-proof.md section 4: News forum cmid 1 on course 2 |
| moodle.discussion.verify (form readback) | live-proven | moodle-lane-proof.md section 4: discussion_id 2 verified via frozen readback |
| moodle.discussion.delete (form first-post delete) | live-proven | moodle-lane-proof.md section 4: post 2 deleted via form confirmation flow, HTTP 200; leftover discussion 1/post 1 from failed run also cleaned |
| moodle.discussion.verify_gone (form read) | live-proven | moodle-lane-proof.md section 4: subject absent from forum page; zero MORROW-LANE-PROOF- occurrences after run |
| mod_forum_add_discussion (AJAX variant) | unsupported | Capability probe: servicenotavailable on Moodle 5.2 (not allowed_from_ajax). Form path is the mechanism. |
| mod_forum_get_forum_discussions (AJAX variant) | unsupported | Capability probe: servicenotavailable on Moodle 5.2. Form path is the mechanism. |
| mod_forum_get_forums_by_courses (AJAX variant) | unsupported | Capability probe: servicenotavailable on Moodle 5.2. Form path is the mechanism. |
| core_course_get_contents (AJAX variant) | unsupported | Capability probe: servicenotavailable on Moodle 5.2. Form path is the mechanism. |
| mod_forum_delete_discussion (AJAX) | unsupported | Not registered in Moodle 5.2 forum db/services.php at all (invalidrecordunknown, byte-identical to a nonexistent function). Undo for discussion create is the form-path first-post delete. |

## Privacy gate: learner-data operations

Rule: no learner-data operation is live-tested until the learner tokenization boundary lands in Morrow for Muse. The desktop privacy engine (LearnerVault, scoped learner tokens, output projection) exists in morrow-fix/packages/gateway-core/src/privacy.ts; the Muse deploy only has generic key-pattern redaction in dispatch/executor.py. Until the boundary is integrated and proven, every flagged op below stays gated.

### Canvas learner-data families and their PII-bearing fields

| Family | PII fields exposed |
|--------|--------------------|
| ai_conversations | student-authored conversation content, user_id |
| analytics | student_id, page_views, participations, tardiness breakdowns |
| assignment_extensions | user_id, extra_time/attempts granted to a learner |
| course_audit_log | user_id of the actor for each audited event |
| course_quiz_extensions | user_id, extra_time/attempts granted to a learner |
| custom_gradebook_columns | column structure is course-level; cell values are per-learner (user_id, content) |
| discussion_topics | author[id, display_name, avatar_image_url], last_reply_by; entries carry learner-authored text |
| enrollments | user_id, user[id, name, short_name, sortable_name, avatar_url, enrollments], sis_user_id, login_id, email |
| grade_change_log | user_id, grader_id, grade_before/after |
| gradebook_history | grader_id, user_id, grade_before/after, graded_at |
| line_items | LTI AGS line items; results carry userId, resultScore, comment |
| liveassessments | assessor/assessee user_ids, scores |
| moderated_grading | provisional grades with user_id, grader_id, score, comments |
| names_and_role | LTI NRPS membership: user_id, name, email, roles, status |
| outcome_results | user_id, user[name], score, submitted_or_assessed_at |
| peer_reviews | assessor_id, assessee user_id, user[name] |
| progress | user_id, completed_at, progress per learner |
| quiz_extensions | user_id, extra_time/attempts granted to a learner |
| quiz_reports | quiz attempt reports: user_id, name, score, answers |
| quiz_statistics | aggregate statistics derived from learner attempts (per-question response distributions) |
| quiz_submission_events | user_id, created_at, event_type, event_data |
| quiz_submission_files | user_id, attachment filenames/urls |
| quiz_submission_user_list | user_id, user[name], attempt status per learner |
| quiz_submissions | user_id, user[name, sortable_name], started_at, finished_at, attempt, score, answers (learner-authored) |
| result | LTI AGS results: userId, resultScore, resultMaximum, comment |
| score | LTI AGS score publish: userId, scoreGiven, comment |
| submission_comments | author_id, author_name, comment (learner-authored), created_at |
| submissions | user_id, user[id, name, short_name, sortable_name, avatar_url], grader_id, submitted_at, body/attachments (learner-authored) |
| what_if_grades | user_id, hypothetical grade values |

Count of flagged Canvas course-level ops: 146.

### Moodle learner-data operations

Any Moodle op whose tool name contains: grade, submission, participant, enrol, roster, user, attempt, feedback_response, survey.
Count of flagged Moodle ops: 26.
These include grade reports, assignment submissions, forum authors, participant rosters, and enrolment reads. The live forum proof used only the educator's own demo account; no other learner identity was read.

## Excluded operations (historical note: set by the operator during the
2026-09-20/21 proof campaign; these are standing product exclusions, not
educator decisions)

| Operation | Exclusion | Reason |
|-----------|-----------|--------|
| canvas_send_message_to_unsubmitted_or_submitted_users_for_quiz | sends messages to people | Messages quiz takers |
| Canvas help ticket creation (account-level, not course-scoped) | submits support tickets | Braden exclusion; no ticket is ever filed by the battery |
| Discussion announcement variants (canvas_create_new_discussion_topic_courses with announcement flag) | sends messages to people | Posting an announcement notifies enrolled users |
| canvas_begin_migration_to_push_to_associated_courses | affects subaccount | Blueprint migrations push to associated courses |
| canvas_update_associated_courses | affects subaccount | Changes blueprint course associations |
| canvas_set_or_remove_restrictions_on_blueprint_course_object | affects subaccount | Changes blueprint restrictions across courses |
| canvas_disable_assignments_currently_enabled_for_grade_export_to_sis | affects subaccount | Changes SIS grade export state |
| canvas_set_feature_flag_courses / canvas_remove_feature_flag_courses | affects subaccount | Feature flags affect account-level feature state |
| canvas_enable_disable_or_clear_explicit_csp_setting_courses | affects subaccount | CSP settings affect account security posture |

## Counts by status

| Status | Canvas + Item Bank | Moodle lane | Total |
|--------|------------------|-------------|-------|
| live-proven | 203 | 2 | 205 |
| pending | 215 | 248 | 463 |
| failed | 14 | 0 | 14 |
| evidence-hold | 5 | 0 | 5 |
| unsupported | 11 | 0 | 11 |
| excluded | 8 | 0 | 8 |
| source-only | 0 | 0 | 0 |
| New Quiz sequence rows | - | - | 10 live-proven, 1 unsupported |
| Moodle lane-level rows (below the M-rows) | - | - | 5 live-proven, 5 unsupported |

Canvas course-scoped ops in reference catalog: 436, plus 20 Item Bank quiz-api ops.
Moodle ops in reference catalog: 250, plus 10 lane-level rows.
Learner-data flagged: 146 Canvas, 26 Moodle.
