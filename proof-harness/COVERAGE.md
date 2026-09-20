# Morrow proof harness coverage report

Built 2026-09-20T06:46:51.198Z against sandbox course 89585.

## What is proven

418 operations were confirmed by reading Canvas back after the request. 7 of 7 educator scenarios pass, and 6 of 6 robustness checks pass.

Of the 1177 operations this run attempted, 35.5% are proven. The rest could not be proven in this sandbox, each for a recorded reason below.

A coverage figure against the Phase 0 prediction is deliberately not given. That prediction was made before anything ran and was wrong for hundreds of rows: the sandbox holds no poll session, no LTI registration, no learner attempt. Measuring against it would report a number known to be meaningless.

## Every operation, and what the evidence says

| Classification | Operations | What it means |
| --- | ---: | --- |
| PROVEN | 418 | Canvas confirmed the effect after the request. |
| NO-TENANT | 275 | No Moodle test tenant is connected to this machine. |
| OUT-OF-SANDBOX | 216 | The change addresses something outside the connected course, which this harness never touches. |
| NO-FIXTURE | 215 | The sandbox course holds no object of this kind to address the route with. |
| PROVIDER-REFUSED | 101 | Canvas refused the request for this connection, so no expected state can be read back. |
| QUEUE-COLLISION | 91 | Another request for the same target was still waiting, so this one was not settled. |
| NEEDS-LEARNER-ATTEMPT | 45 | The object exists only after a learner attempt, and the sandbox course has none. |
| NO-READBACK | 37 | Canvas has no read that shows the saved result of this change. |
| OUTBOUND | 24 | The change leaves Canvas for someone: a ticket, a message, or another course. |
| PERSON-SETTINGS | 17 | The change alters the signed-in person's own account settings rather than course content. |
| NEEDS-FIXTURE | 16 | Needs an assignment whose description carries an image with no description. |
| PROVABLE | 7 |  |
| IRREVERSIBLE | 5 | The change cannot be undone on a person or a whole course, so it is never attempted here. |
| BLOCKED-OTHER | 4 | This run has no quiz to order. |

## Defects

| Operation | What happened |
| --- | --- |
| `cleanup:MORROWPROOF1789874351` | 16 object(s) this run made were not removed: override_id, question_id, entry_id, item_id, topic_id, page_id, group_id, event_id, group_category_id, column_id, section_id, assignment_group_id, module_id, topic_id, assignment_id, page_id. |
| `cleanup:verified-against-canvas` | 3 object(s) this harness made remain: pages:MORROWPROOF1789874351 wiki_page_title, assignments:MORROWPROOF1789883856 assignment, rubrics:MORROWSWEEP1789677962 rubric two. |
| `cleanup:MORROWPROOF1789883856` | 4 object(s) this run made were not removed: item_id, topic_id, assignment_id, page_id. |
| `morrow_audit_course` | The control answered with an error or nothing: null |

The findings this run produced, including the one that explains most of the blocked rows, are in FINDINGS.md.

