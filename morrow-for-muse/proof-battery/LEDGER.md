# Morrow for Muse: Full Operation Proof Battery Ledger

Braden directive 2026-09-20: every course-level Canvas and Moodle read/write
operation must be proven live via the browser-owned transport. No operation
ships unproven. New Quiz and Item Bank operations are the priority.

## Proof standard
Each operation needs: (1) a batch rendered by transport/batch.py, (2) live
dispatch through the educator's browser-owned session, (3) readback
verification, (4) full cleanup of disposable test objects, (5) sanitized
result fixture stored here. A "proven" row means create/readback/update/
delete/verify-gone where the operation supports writes, or read-shape
verification where read-only.

## Canvas course-level operations (course 89585, BIOL 101)

### Content reads
| # | Operation | Status | Evidence |
|---|-----------|--------|----------|
| C-R1 | Get course | PROVEN | keepalive 200, principal 28206 |
| C-R2 | List assignments | PROVEN | lifecycle readbacks 2026-09-20 |
| C-R3 | Get assignment | PROVEN | 4045367, 4045368 readbacks |
| C-R4 | List pages | PENDING | |
| C-R5 | Get page | PENDING | |
| C-R6 | List modules | PENDING | |
| C-R7 | Get module + module items | PENDING | |
| C-R8 | List discussions | PENDING | |
| C-R9 | Get discussion | PENDING | |
| C-R10 | List files | PENDING | |
| C-R11 | List enrollments/users | PENDING | tokenization assertion applies |
| C-R12 | List submissions (gradebook) | PENDING | tokenization assertion applies |
| C-R13 | List classic quizzes | PENDING | |
| C-R14 | Get classic quiz + questions | PENDING | |

### Content writes
| # | Operation | Status | Evidence |
|---|-----------|--------|----------|
| C-W1 | Assignment create/update/delete/verify-gone | PROVEN | 4045367 (18:13 UTC), 4045368 (18:30 UTC) |
| C-W2 | Page create/update/delete/verify-gone | PENDING | |
| C-W3 | Module create/update/delete/verify-gone | PENDING | |
| C-W4 | Module item add/remove | PENDING | |
| C-W5 | Discussion create/update/delete/verify-gone | PENDING | |
| C-W6 | Classic quiz create/update/delete + question add | PENDING | |
| C-W7 | Submission grade update (sandbox-safe) | PENDING | needs enrolled test student |

### New Quiz operations (PRIORITY)
| # | Operation | Status | Evidence |
|---|-----------|--------|----------|
| NQ-R1 | List New Quizzes for course | PROVEN | provisioning battery 2026-09-20 |
| NQ-R2 | Get New Quiz + items | PROVEN | provisioning battery 2026-09-20 |
| NQ-W1 | New Quiz create/update/delete/verify-gone | PROVEN | assignment 4045366 lifecycle 2026-09-20 (quiz 506477 orphan caveat open) |
| NQ-W2 | New Quiz item create/update/delete | PENDING | |
| NQ-W3 | New Quiz bank-item link/unlink | PENDING | |

### Item Bank operations (PRIORITY)
| # | Operation | Status | Evidence |
|---|-----------|--------|----------|
| IB-R1 | List Item Banks for course | PROVEN | bank 4017 read 2026-09-20 |
| IB-R2 | Get bank + list bank items | PROVEN | provisioning battery 2026-09-20 |
| IB-W1 | Bank create/update/archive | PROVEN | banks 4040, 4041 archived 2026-09-20 |
| IB-W2 | Bank item create/update/delete | PENDING | entry 82698 archived with bank |
| IB-W3 | Bank share/unshare | NOT PROVEN | delta-2 blocker: claimed live, never attempted |

## Moodle course-level operations (sandbox.moodledemo.net, course 2)

### Reads
| # | Operation | Status | Evidence |
|---|-----------|--------|----------|
| M-R1 | Get course | PROVEN | course 2 read 2026-09-20 |
| M-R2 | List forums / get forum | PROVEN | News forum 1 read 2026-09-20 |
| M-R3 | List discussions / get discussion | PROVEN | discussion 1 readback 2026-09-20 |
| M-R4 | List assignments | PENDING | |
| M-R5 | Grade report read | PENDING | tokenization assertion applies |
| M-R6 | Enrolled users read | PENDING | tokenization assertion applies |
| M-R7 | Lesson pages read | PENDING | |

### Writes
| # | Operation | Status | Evidence |
|---|-----------|--------|----------|
| M-W1 | Forum discussion create/read/delete/verify-gone | PROVEN | discussion 1, post 1, 2026-09-20 |
| M-W2 | Forum post reply create/delete | PROVEN | reply create + reply delete (posts 8, 14 deleted), 2026-09-20 |
| M-W3 | Assignment grade update (sandbox-safe) | PENDING | |

## Privacy gate
Every read path touching learner identities (C-R11, C-R12, M-R5, M-R6)
must assert learner tokenization holds: no untokenized learner identity
reaches the agent. Any path exposing one is a FAIL, not a note.
